import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogBridge } from '../dialogs.mjs';

// A fake OMP UI: each dialog stays open until answered locally or aborted (resolving like OMP's #presentDialog).
function fakeUi() {
  const pending = [];
  const dialog = (fallback, signalArg) => (...args) => new Promise(resolve => {
    const signal = args[signalArg]?.signal;
    const entry = { args, resolve };
    pending.push(entry);
    signal?.addEventListener('abort', () => { entry.aborted = true; resolve(fallback); }, { once: true });
  });
  return {
    pending,
    ui: {
      select: dialog(undefined, 2), confirm: dialog(false, 2), input: dialog(undefined, 2),
      editor: dialog(undefined, 2), askDialog: dialog(undefined, 1), approve: dialog(false, 1),
      notify() {}, setStatus() {},
    },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const { ui, pending } = fakeUi();
  let changes = 0;
  const bridge = createDialogBridge({ onChange: () => changes++ });
  bridge.attach(ui);
  bridge.attach(ui); // idempotent
  return { ui, pending, bridge, changes: () => changes };
}

const QUESTION = { id: 'db', question: 'Which database?', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }], recommended: 0 };

test('single-question ask answered remotely by label, index or loose label', async () => {
  for (const choice of ['SQLite', 1, 'sqlite']) {
    const { ui, pending, bridge } = setup();
    const result = ui.askDialog([QUESTION], { timeout: 1000 });
    await tick();
    const [view] = bridge.list();
    assert.equal(view.kind, 'ask');
    assert.equal(view.questions[0].options[0].description, 'relational');
    bridge.answer(undefined, { choice, note: 'small app' });
    assert.deepEqual(await result, { kind: 'submit', results: [{ id: 'db', question: 'Which database?', options: ['Postgres', 'SQLite'], multi: false, selectedOptions: ['SQLite'], note: 'small app' }] });
    assert.equal(pending[0].aborted, true, 'local dialog is closed');
    assert.equal(pending[0].args[1].timeout, 1000, 'dialog options pass through');
    assert.deepEqual(bridge.list(), []);
  }
});

test('ask: custom text, multi-select, several questions, chat and cancel', async () => {
  const { ui, bridge } = setup();
  let result = ui.askDialog([QUESTION]); await tick();
  bridge.answer(undefined, { text: 'DuckDB' });
  assert.deepEqual((await result).results[0].selectedOptions, []);
  result = ui.askDialog([{ ...QUESTION, multi: true }]); await tick();
  bridge.answer(undefined, { choices: [0, 'SQLite'] });
  assert.deepEqual((await result).results[0].selectedOptions, ['Postgres', 'SQLite']);
  const second = { id: 'orm', question: 'ORM?', options: [{ label: 'Drizzle' }, { label: 'None' }] };
  result = ui.askDialog([QUESTION, second]); await tick();
  assert.throws(() => bridge.answer(undefined, { choice: 0 }), /2 questions/);
  bridge.answer(undefined, { answers: [{ id: 'orm', choice: 'None' }, { id: 'db', choice: 'Postgres' }] });
  assert.deepEqual((await result).results.map(r => r.selectedOptions[0]), ['Postgres', 'None']);
  result = ui.askDialog([QUESTION]); await tick();
  bridge.answer(undefined, { chat: true });
  assert.deepEqual(await result, { kind: 'chat' });
  result = ui.askDialog([QUESTION]); await tick();
  bridge.answer(undefined, { cancel: true });
  assert.equal(await result, undefined);
});

test('invalid answers throw and leave the dialog open', async () => {
  const { ui, bridge } = setup();
  const result = ui.askDialog([QUESTION]); await tick();
  assert.throws(() => bridge.answer(undefined, { choice: 'MySQL' }), /not one of/);
  assert.throws(() => bridge.answer(undefined, { choice: 5 }), /out of range/);
  assert.throws(() => bridge.answer(undefined, {}), /needs choice/);
  assert.throws(() => bridge.answer('dlg-999', { choice: 0 }), /no longer open/);
  assert.equal(bridge.list().length, 1);
  bridge.answer(bridge.list()[0].id, { choice: 0 });
  assert.equal((await result).results[0].selectedOptions[0], 'Postgres');
});

test('select, confirm, approve, input and editor', async () => {
  const { ui, bridge } = setup();
  const cases = [
    [() => ui.select('Pick', ['Approve', { label: 'Deny', description: 'no' }]), { choice: 'deny' }, 'Deny'],
    [() => ui.confirm('Sure?', 'Really'), { confirm: true }, true],
    [() => ui.approve({ full: 'bash: rm -rf build', compact: 'bash' }), { choice: 'Approve' }, true],
    [() => ui.approve({ full: 'bash' }), { confirm: false }, false],
    [() => ui.input('Name?'), { text: 'Ada' }, 'Ada'],
    [() => ui.editor('Edit', 'draft'), { text: 'final' }, 'final'],
    [() => ui.confirm('Sure?', 'Really'), { cancel: true }, false],
  ];
  for (const [open, answer, expected] of cases) {
    const result = open(); await tick();
    assert.equal(bridge.list().length, 1);
    bridge.answer(undefined, answer);
    assert.equal(await result, expected);
  }
});

test('a local answer wins and removes the remote entry; parent abort closes it too', async () => {
  const { ui, pending, bridge } = setup();
  const result = ui.select('Pick', ['A', 'B']); await tick();
  pending[0].resolve('A');
  assert.equal(await result, 'A');
  assert.deepEqual(bridge.list(), []);
  assert.throws(() => bridge.answer(undefined, { choice: 'B' }), /No dialog is open/);
  const parent = new AbortController();
  const aborted = ui.input('Name?', undefined, { signal: parent.signal }); await tick();
  parent.abort();
  assert.equal(await aborted, undefined);
  assert.deepEqual(bridge.list(), []);
});

test('the oldest dialog is answered when dialog_id is omitted', async () => {
  const { ui, bridge } = setup();
  const first = ui.input('First'); const second = ui.input('Second'); await tick();
  assert.deepEqual(bridge.list().map(d => d.title), ['First', 'Second']);
  bridge.answer(undefined, { text: 'one' });
  bridge.answer(undefined, { text: 'two' });
  assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);
});
