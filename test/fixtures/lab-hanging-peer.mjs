// Local WebSocket peer that accepts an upgrade but never answers close frames.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const server = createServer((_req, res) => res.writeHead(404).end());
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('data', () => {});
  socket.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
