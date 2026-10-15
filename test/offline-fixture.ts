// Real-TUI smoke test provider. Every model request goes to this local deterministic endpoint.
// - A prompt containing ASK_TEST makes the model call the `ask` tool (multiple choice).
// - After a tool result, the model echoes it back as "ANSWER: …".
// - Anything else is echoed as "TERMINAL_RECEIVED: …".
// Run: omp --no-extensions -e index.ts -e test/offline-fixture.ts --model omp-wand-test/echo
import { createServer } from 'node:http';

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'offline-test', object: 'chat.completion.chunk', model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

export default async function (pi: any) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const messages = JSON.parse(body).messages;
    const last = messages.at(-1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (last.role === 'tool') {
      res.write(chunk({ role: 'assistant', content: `ANSWER: ${text(last.content)}` }));
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    const prompt = text(messages.filter((m: any) => m.role === 'user').at(-1)?.content);
    if (prompt.includes('ASK_TEST')) {
      const args = { questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'DuckDB' }], recommended: 0 }] };
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_ask_1', type: 'function', function: { name: 'ask', arguments: JSON.stringify(args) } }] }));
      res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      return;
    }
    res.write(chunk({ role: 'assistant', content: `TERMINAL_RECEIVED: ${prompt}` }));
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  pi.registerProvider('omp-wand-test', {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKey: 'offline-test-only', api: 'openai-completions',
    models: [{ id: 'echo', name: 'Offline Echo', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  pi.on('session_shutdown', () => { server.closeAllConnections(); server.close(); });
}
