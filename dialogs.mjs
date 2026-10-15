// Remote answers for OMP's native dialogs.
//
// OMP gives tools (ask), tool approvals and extensions one shared UI object. We wrap its dialog
// methods so each open dialog is listed remotely and can be answered from either side. The local
// dialog keeps running; whichever side answers first wins and the other is aborted. This is the
// same race OMP uses for collab guests, so local dialogs close cleanly on abort.

const BRIDGED = Symbol.for('omp-wand.bridged');
const clipHead = (text, max) => typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text;

const optionLabel = option => typeof option === 'string' ? option : option?.label;
const optionView = option => typeof option === 'string' ? { label: option }
  : { label: option.label, ...(option.description ? { description: clipHead(option.description, 500) } : {}) };

/** Resolve a choice (0-based index or label) against a label list. Tolerates case and the "(Recommended)" suffix. */
function pick(labels, choice, field = 'choice') {
  if (Number.isInteger(choice)) {
    if (choice < 0 || choice >= labels.length) throw new Error(`${field} index ${choice} is out of range 0–${labels.length - 1}`);
    return labels[choice];
  }
  if (typeof choice !== 'string' || !choice.trim()) throw new Error(`${field} must be an option label or a 0-based index`);
  const norm = value => value.trim().toLowerCase().replace(/ \(recommended\)$/, '');
  const exact = labels.find(label => label === choice);
  if (exact !== undefined) return exact;
  const loose = labels.filter(label => norm(label) === norm(choice));
  if (loose.length === 1) return loose[0];
  throw new Error(`${field} "${choice}" is not one of: ${labels.map(l => JSON.stringify(l)).join(', ')}`);
}

const yesNo = (answer, yes, no) => {
  if (typeof answer.confirm === 'boolean') return answer.confirm;
  if (answer.choice !== undefined) return pick([yes, no], answer.choice) === yes;
  throw new Error(`Answer with confirm: true/false (or choice "${yes}"/"${no}")`);
};
const textOf = answer => {
  if (typeof answer.text !== 'string') throw new Error('Answer with text');
  return answer.text;
};

function askResult(questions, answer) {
  if (answer.chat === true) return { kind: 'chat' };
  let items = answer.answers;
  if (items === undefined) {
    if (questions.length !== 1) throw new Error(`This dialog has ${questions.length} questions; answer with answers: [{ id, choice | choices | text }]`);
    items = [answer];
  }
  if (!Array.isArray(items) || items.length !== questions.length) throw new Error(`answers must contain exactly ${questions.length} item(s), one per question`);
  const byId = new Map(items.filter(item => typeof item?.id === 'string').map(item => [item.id, item]));
  return {
    kind: 'submit',
    results: questions.map((q, index) => {
      const item = byId.get(q.id) ?? (byId.size ? undefined : items[index]);
      if (!item || typeof item !== 'object') throw new Error(`Missing answer for question ${q.id}`);
      const labels = q.options.map(o => o.label);
      const multi = q.multi ?? false;
      const result = { id: q.id, question: q.question, options: labels, multi, selectedOptions: [] };
      if (multi) {
        const choices = item.choices ?? (item.choice !== undefined ? [item.choice] : []);
        if (!Array.isArray(choices)) throw new Error(`choices for ${q.id} must be an array`);
        result.selectedOptions = [...new Set(choices.map(c => pick(labels, c, `choices for ${q.id}`)))];
      } else if (item.choice !== undefined) {
        result.selectedOptions = [pick(labels, item.choice, `choice for ${q.id}`)];
      } else if (typeof item.text !== 'string' || !item.text.trim()) {
        throw new Error(`Question ${q.id} needs choice (label or index) or text (a custom answer)`);
      }
      if (typeof item.text === 'string' && item.text.trim()) result.customInput = item.text;
      if (typeof item.note === 'string' && item.note.trim()) result.note = item.note;
      return result;
    }),
  };
}

// For each wrapped method: how to describe the open dialog, and how to turn a remote answer into the
// value the local method would have returned. `cancel: true` returns what Esc would.
const KINDS = {
  select: {
    describe: ([title, options]) => ({ title, options: (options || []).map(optionView) }),
    resolve: ([, options], answer) => answer.cancel ? undefined : pick((options || []).map(optionLabel), answer.choice),
  },
  confirm: {
    describe: ([title, message]) => ({ title, message }),
    resolve: (_args, answer) => answer.cancel ? false : yesNo(answer, 'Yes', 'No'),
  },
  approve: {
    describe: ([prompt]) => ({ title: 'Tool approval', message: typeof prompt === 'string' ? prompt : prompt?.full ?? prompt?.compact }),
    resolve: (_args, answer) => answer.cancel ? false : yesNo(answer, 'Approve', 'Deny'),
  },
  input: {
    describe: ([title, placeholder]) => ({ title, ...(placeholder ? { placeholder } : {}) }),
    resolve: (_args, answer) => answer.cancel ? undefined : textOf(answer),
  },
  editor: {
    describe: ([title, prefill]) => ({ title, ...(prefill ? { prefill: clipHead(prefill, 4000) } : {}) }),
    resolve: (_args, answer) => answer.cancel ? undefined : textOf(answer),
  },
  askDialog: {
    kind: 'ask',
    describe: ([questions]) => ({
      questions: (questions || []).map(q => ({
        id: q.id, question: q.question, ...(q.header ? { header: q.header } : {}),
        options: q.options.map(o => ({ ...optionView(o), ...(o.preview ? { preview: clipHead(o.preview, 800) } : {}) })),
        multi: q.multi ?? false, ...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
      })),
    }),
    resolve: ([questions], answer) => answer.cancel ? undefined : askResult(questions || [], answer),
  },
};
const DIALOG_OPTIONS_ARG = { select: 2, confirm: 2, approve: 1, input: 2, editor: 2, askDialog: 1 };

export function createDialogBridge({ onChange = () => {} } = {}) {
  const open = new Map();
  let seq = 0;

  async function race(name, original, args) {
    const spec = KINDS[name];
    const id = `dlg-${++seq}`;
    const optionsIndex = DIALOG_OPTIONS_ARG[name];
    const dialogOptions = args[optionsIndex];
    const parentSignal = dialogOptions?.signal;
    const localAbort = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, localAbort.signal]) : localAbort.signal;
    const localArgs = [...args];
    while (localArgs.length < optionsIndex) localArgs.push(undefined);
    localArgs[optionsIndex] = { ...dialogOptions, signal };

    let answerRemote;
    const remote = new Promise(resolve => { answerRemote = resolve; });
    open.set(id, {
      view: { id, kind: spec.kind ?? name, ...spec.describe(args), opened_at: new Date().toISOString() },
      answer: raw => {
        const value = spec.resolve(args, raw); // throws on an invalid answer; the dialog stays open
        open.delete(id);
        answerRemote({ value });
      },
    });
    onChange();
    const local = Promise.resolve().then(() => original(...localArgs))
      .then(value => ({ source: 'local', value }), error => ({ source: 'local', error }));
    try {
      const winner = await Promise.race([local, remote.then(({ value }) => ({ source: 'remote', value }))]);
      if (winner.source === 'remote') localAbort.abort();
      if (winner.error) throw winner.error;
      return winner.value;
    } finally {
      open.delete(id);
      onChange();
    }
  }

  return {
    /** Wrap the dialog methods of an OMP UI context in place. Safe to call repeatedly. */
    attach(ui) {
      if (!ui || typeof ui !== 'object' || ui[BRIDGED]) return;
      for (const name of Object.keys(KINDS)) {
        const original = ui[name];
        if (typeof original !== 'function') continue;
        ui[name] = (...args) => race(name, original, args);
      }
      ui[BRIDGED] = true;
    },
    list: () => [...open.values()].map(d => d.view),
    /** Answer one open dialog. dialog_id defaults to the oldest open dialog. */
    answer(dialogId, answer) {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Answer must be an object');
      const entry = dialogId ? open.get(dialogId) : open.values().next().value;
      if (!entry) throw new Error(dialogId ? `Dialog ${dialogId} is no longer open; read the session again` : 'No dialog is open');
      entry.answer(answer);
      return { answered: entry.view.id, kind: entry.view.kind };
    },
  };
}
