// Type-check harness only. Deployment uses Deno's native env and npm resolver.
declare const Deno: { env: { get(name: string): string | undefined } };
declare module 'npm:ws' {
  export { WebSocket, WebSocketServer } from 'ws';
}
