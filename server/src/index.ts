import { defineRoom, defineServer } from 'colyseus';
import type { NextFunction, Request, Response } from 'express';
import { StahlbunkerRoom } from './StahlbunkerRoom.js';

const port = Number.parseInt(process.env.PORT ?? '2567', 10);
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173';

export const server = defineServer({
  rooms: {
    stahlbunker: defineRoom(StahlbunkerRoom),
  },
  express: (app) => {
    app.use((request: Request, response: Response, next: NextFunction) => {
      response.header('Access-Control-Allow-Origin', clientOrigin);
      response.header('Access-Control-Allow-Headers', 'Content-Type');
      if (request.method === 'OPTIONS') return response.sendStatus(204);
      next();
    });
    app.get('/health', (_request: Request, response: Response) => {
      response.json({ ok: true, service: 'stahlbunker-server', protocolVersion: 1 });
    });
  },
});

await server.listen(port);
console.log(`[stahlbunker] authoritative server listening on :${port}`);
