"""Relay emulator DNS to the runner's resolver, which may be loopback-only."""
import socket
import socketserver

with open('/etc/resolv.conf', encoding='utf-8') as config:
    servers = [line.split()[1] for line in config if line.startswith('nameserver ')]
if not servers:
    raise SystemExit('Runner DNS is unavailable')

class Resolver(socketserver.BaseRequestHandler):
    def handle(self):
        data, server = self.request
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as upstream:
                upstream.settimeout(4)
                upstream.sendto(data, (servers[0], 53))
                response, _ = upstream.recvfrom(8192)
                server.sendto(response, self.client_address)
        except OSError:
            pass

class Server(socketserver.ThreadingUDPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(('127.0.0.1', 53), Resolver) as server:
    print('DNS relay ready', flush=True)
    server.serve_forever()
