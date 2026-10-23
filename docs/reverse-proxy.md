# Reverse proxy and remote access

LaneSignal speaks plain HTTP on port 8080. Put HTTPS in front of it whenever it's reachable beyond your LAN. The Android app also expects HTTPS.

## Three settings to get right

1. **`LANESIGNAL_PUBLIC_URL`** is the URL people use, such as `https://lanesignal.example.com`. Sign-in trusts this origin, and notification links point at it.
2. **`LANESIGNAL_TRUST_PROXY`** tells LaneSignal how far to trust `X-Forwarded-For` when it works out the client's IP. Sign-in rate limiting is per client IP, so this matters.

   | Setup | Value |
   |---|---|
   | One reverse proxy in front (Caddy, nginx, Traefik, NPM, `tailscale serve`) | `1` |
   | Two proxies, e.g. Cloudflare → Caddy | `2` |
   | Proxies only on known addresses | `loopback` or `10.0.0.0/8, 172.16.0.0/12` |
   | Clients connect straight to LaneSignal | `false` (default) |

   Never use `true`. It trusts any `X-Forwarded-For` a client sends, so anyone can spoof their IP and get around the sign-in limit.
3. **Long requests:**
   - `/api/events` is a long-lived Server-Sent Events stream.
   - Agents long-poll for decisions for up to 300s, and nothing is sent while they wait.

   Turn off response buffering, and set read timeouts above 300s. Most proxies default to 60s, which cuts long-polls off.

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
    }
}
```

## Nginx Proxy Manager (common with Dockge)

1. Add a proxy host for your domain that forwards to `lanesignal:8080`, if both are on a shared Docker network (see the commented `networks` block in the stack), or to `<host>:8080`.
2. Enable *Websockets Support*, which also helps streaming, and request an SSL certificate.
3. Under *Advanced*, add:

   ```nginx
   proxy_buffering off;
   proxy_read_timeout 310s;
   ```

4. Set `LANESIGNAL_TRUST_PROXY=1`.

## Tailscale

If only you and your devices need it, `tailscale serve` gives HTTPS on your tailnet with no open ports:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

Then set `LANESIGNAL_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `LANESIGNAL_TRUST_PROXY=1`. Phones on the tailnet can use the Android app against that URL.

## Checking it

```bash
curl -N -H "authorization: Bearer <session or key>" https://lanesignal.example.com/api/events
```

You should see `retry: 3000`, then a `: ping` every 25s. If nothing arrives until the connection closes, the proxy is still buffering.
