import { defineRoom, defineServer, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG } from '../../src/config.js';
import { StahlbunkerRoom } from './StahlbunkerRoom.js';

const port = Number.parseInt(process.env.PORT ?? '2567', 10);
const clientOrigins = new Set(
  (process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173,http://127.0.0.1:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const releaseVersion = process.env.RELEASE_VERSION ?? process.env.COMMIT_SHA ?? 'development';

matchMaker.controller.getCorsHeaders = (headers) => {
  const origin = headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin !== null && clientOrigins.has(origin) ? origin : 'null',
    Vary: 'Origin',
  };
};

export const server = defineServer({
  transport: new WebSocketTransport({
    verifyClient: ({ origin }: { origin?: string }) => origin === undefined || origin === '' || clientOrigins.has(origin),
  }),
  rooms: {
    stahlbunker: defineRoom(StahlbunkerRoom),
  },
  express: (app) => {
    app.use((request: Request, response: Response, next: NextFunction) => {
      const requestOrigin = request.header('Origin');
      const originAllowed = requestOrigin !== undefined && clientOrigins.has(requestOrigin);
      response.removeHeader('Access-Control-Allow-Origin');
      if (originAllowed) {
        response.header('Access-Control-Allow-Origin', requestOrigin);
      }
      response.vary('Origin');
      response.header('Access-Control-Allow-Headers', 'Content-Type');
      response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (request.method === 'OPTIONS') return response.sendStatus(requestOrigin === undefined || originAllowed ? 204 : 403);
      next();
    });
    app.get('/health', (_request: Request, response: Response) => {
      response.json({
        ok: true,
        service: 'stahlbunker-server',
        protocolVersion: CONFIG.coop.protocolVersion,
        releaseVersion,
        node: process.version,
      });
    });
  },
});

await server.listen(port);
console.log(`[stahlbunker] authoritative server listening on :${port}`);
