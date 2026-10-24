# Reverse proxy and remote access

LaneSignal speaks plain HTTP on port 8080. Put HTTPS in front of it whenever it's reachable beyond your LAN. The Android app also expects HTTPS.

## Three settings to get right

1. **`LANESIGNAL_PUBLIC_URL`** is the URL people use, such as `https://lanesignal.example.com`. Sign-in trusts this origin, and notification links point at it.
2. **`LANESIGNAL_TRUST_PROXY`** tells LaneSignal how far to trust `X-Forwarded-For` when it works out the client's IP. Sign-in rate limiting is per client IP, so this matters.

   **Rule:** trust a proxy only when the proxy is the *only* way to reach LaneSignal. If clients can still reach the published port directly, any trust setting lets them write their own `X-Forwarded-For` and pick their IP.

   | Setup | Value |
   |---|---|
   | Clients connect straight to the port (the default Dockge stack) | `false` (default) |
   | One proxy on the host (Caddy, nginx, `tailscale serve`), with the port bound to `127.0.0.1` | `1` |
   | One containerised proxy (Nginx Proxy Manager, Traefik, Caddy) on a shared Docker network, with no `ports:` | `1` |
   | Two proxies, e.g. Cloudflare → Caddy, with Caddy set to trust Cloudflare's ranges (`trusted_proxies`) so it passes the client IP on | `2` |
   | Only specific proxy addresses, e.g. the proxy container's network | `172.18.0.0/16` (an address or subnet list) |

   Never use `true`. It trusts any `X-Forwarded-For` a client sends, so the server logs a warning if you set it. An invalid value stops startup with a message.

   With the wrong setting the limit either stops working, or everyone shares the proxy's IP and five bad attempts lock everyone out for a minute.
3. **Long requests:**
   - `/api/events` is a long-lived Server-Sent Events stream.
   - With answering on the dashboard on (the default), agents wait for decisions: up to 300s for `get_escalation`, up to 1h for `wait_for_decisions`, and up to 24h for `GET /api/wait`. The longer waits send something every 20 seconds (MCP notifications, or a space on `/api/wait`), so idle timeouts, Cloudflare's 100-second limit included, don't cut them off.
   - The single-escalation long-poll (`GET /api/escalations/:id?wait=`) sends nothing until it answers.

   Turn off response buffering, and set read timeouts above 300s. Most proxies default to 60s, which cuts the single-escalation long-poll off.
4. **Uploads:** agents upload attachments of up to `LANESIGNAL_ATTACHMENT_MAX_MB` (5 MB by default) to `POST /api/attachments`. nginx refuses bodies over 1 MB unless you raise `client_max_body_size` (e.g. `6m`); Caddy and Traefik have no limit by default.

## Caddy

```caddyfile
lanesignal.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
		transport http {
			read_timeout 310s
		}
	}
}
```

## nginx

```nginx
server {
    server_name lanesignal.example.com;
    listen 443 ssl;   # certificates omitted

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # SSE (LaneSignal also sends X-Accel-Buffering: no)
        proxy_read_timeout 310s;      # long-polls wait up to 300s
        client_max_body_size 6m;      # attachments (5 MB by default)
    }
}
```

## Nginx Proxy Manager (common with Dockge)

1. Put LaneSignal on NPM's Docker network: in the stack, remove `ports:` and uncomment the `networks` lines, using NPM's network name. Then add a proxy host for your domain that forwards to `lanesignal:8080`. NPM runs in a container, so it can't reach a port bound to the host's `127.0.0.1`. If you forward to `<host>:8080` instead, the port stays open on your LAN; in that case keep `LANESIGNAL_TRUST_PROXY=false`.
2. Enable *Websockets Support*, which also helps streaming, and request an SSL certificate.
3. Under *Advanced*, add:

   ```nginx
   proxy_buffering off;
   proxy_read_timeout 310s;
   ```

4. Set `LANESIGNAL_TRUST_PROXY=1`.

## Tailscale

If only you and your devices need it, `tailscale serve` gives HTTPS on your tailnet. In the stack, bind the port to localhost (`"127.0.0.1:8080:8080"`) so nothing else on the LAN can reach it, then:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Set `LANESIGNAL_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `LANESIGNAL_TRUST_PROXY=1`. Phones on the tailnet can use the Android app against that URL.

## Checking it

```bash
curl -N -H "authorization: Bearer <session or key>" https://lanesignal.example.com/api/events
```

You should see `retry: 3000`, then a `: ping` every 25s. If nothing arrives until the connection closes, the proxy is still buffering.
