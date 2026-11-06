# AnglerProxy: Going Home

> a fork of BrotherIontachs AnglerProxy made with love ❤️❤️

AnglerProxy is a small HTTP forward proxy for devices that support manual proxy
settings, including ChromeOS. It forwards HTTP requests and tunnels HTTPS with
`CONNECT`; it does not decrypt or inspect HTTPS traffic.

## Run

Requires Node.js 20.12 or newer. Copy `.env.example` to `.env`, edit the values
as needed, then start the proxy from the project directory:

```bash
cp .env.example .env
pnpm start
```

By default, the proxy listens on `127.0.0.1:3000`, which is only reachable from
the computer running it.

To let another device on a trusted local network connect, bind to the server's
LAN address and set credentials:

```ini
HOST = "127.0.0.1"
PORT = "3000"
PROXY_USERNAME = "choose-a-username"
PROXY_PASSWORD = "choose-a-long-password"
```

Use the address of the computer running AnglerProxy for `HOST`. Allow the
selected port through the host firewall only for trusted devices or networks.
Credentials are mandatory when listening on a non-loopback address.

## Configure ChromeOS

1. Open the Wi-Fi network's settings in ChromeOS and select its manual proxy
   configuration.
2. Enter the AnglerProxy computer's LAN IP address and port (`3000` by default)
   as the HTTP proxy. If ChromeOS offers separate HTTP and HTTPS proxy fields,
   use the same address and port for both; enable the option to use one proxy
   for all protocols if available.
3. Save the settings. If prompted, provide the configured proxy username and
   password.

The Chromebook and proxy computer must be able to reach each other on the
network. The proxy only allows destinations with public IP addresses and
accepts HTTPS tunnels on port 443.

## Security

Do not expose an unauthenticated proxy to the internet. Proxy authentication
uses HTTP Basic authentication and is not encrypted by the proxy itself; use it
only on a trusted network or through a VPN, and restrict access with firewall
rules. The proxy rejects private and local destination addresses to reduce
access to internal services.

## Tests

```bash
pnpm test
```
