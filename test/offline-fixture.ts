// Real TUI smoke test. Every model request uses this local deterministic endpoint.
import { createServer } from 'node:http';
export default async function (pi: any) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages.filter((m: any) => m.role === 'user').at(-1)?.content;
    const text = `TERMINAL_RECEIVED: ${typeof prompt === 'string' ? prompt : JSON.stringify(prompt)}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'offline-test', object: 'chat.completion.chunk', model: 'echo', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'offline-test', object: 'chat.completion.chunk', model: 'echo', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  pi.registerProvider('omp-wand-test', {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKey: 'offline-test-only', api: 'openai-completions',
    models: [{ id: 'echo', name: 'Offline Echo', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  pi.on('session_shutdown', () => { server.closeAllConnections(); server.close(); });
}
