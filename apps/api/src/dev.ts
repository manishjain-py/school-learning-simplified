import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler } from './index.js';

const root = resolve(process.env.LOCAL_CONTENT_DIR || '../../content/public');
const mediaRoot = resolve(process.env.LOCAL_MEDIA_DIR || '../../.local/content-media');
process.env.LOCAL_CONTENT_DIR = root;
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/config.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ apiBaseUrl: '/api', region: 'us-east-2', userPoolId: process.env.USER_POOL_ID || '', userPoolClientId: process.env.USER_POOL_CLIENT_ID || '', release: 'local-preview' }));
      return;
    }
    if (url.pathname.startsWith('/content/') || url.pathname.startsWith('/media/')) {
      const staticRoot = url.pathname.startsWith('/media/') ? mediaRoot : root;
      const file = resolve(staticRoot, decodeURIComponent(url.pathname).replace(/^\/(?:content|media)\//, ''));
      if (!file.startsWith(staticRoot + sep)) { res.writeHead(403).end(); return; }
      const bytes = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.mp3') ? 'audio/mpeg' : 'application/json');
      res.end(bytes); return;
    }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 12_000) { res.writeHead(413).end(); return; } }
    const event = {
      version: '2.0', routeKey: '$default', rawPath: url.pathname, rawQueryString: url.search.slice(1),
      queryStringParameters: Object.fromEntries(url.searchParams), headers: req.headers, body,
      requestContext: { requestId: 'local', http: { method: req.method, path: url.pathname } }, isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = await handler(event);
    if (typeof result === 'string') { res.end(result); return; }
    res.writeHead(result.statusCode || 200, result.headers as Record<string, string>);
    res.end(result.body || '');
  } catch { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Local content is not available. Set LOCAL_CONTENT_DIR to the exported public package.' })); }
}).listen(4181, '127.0.0.1', () => console.log('SLS local public-content API: http://127.0.0.1:4181 (private routes require the deployed JWT gateway)'));
