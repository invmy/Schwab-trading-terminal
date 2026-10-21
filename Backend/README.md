# Backend

A cross-platform backend server written in Go that you can run on any platform.

## How to run 

Download the project files and create the corresponding startup script,You also need to configure the TLS certificate.

## command
```bash
#RUN
go run main.go

#build
go build main.go
```

## Environment Variables

| Environment Variable | Default / Example Value | Description |
| :--- | :--- | :--- |
| `SCHWAB_CLIENT_ID` | `""` | Schwab Client ID |
| `SCHWAB_CLIENT_SECRET` | `""` | Schwab Client Secret |
| `PORT` | `"2333"` | Service port number |
| `ONLY_READ` | `"true"` | Read-only mode ,If you want to place an order, just set it to false. |
| `WS_URL` | `""` | Set the WS server address to a specific server, When optimizing WS network quality, you'll need to use (Official: `wss://streamer-api.schwab.com/ws`) |

## Startup Script

### windows
```cmd
@echo off

:: envs
set SCHWAB_CLIENT_ID=
set SCHWAB_CLIENT_SECRET=
set PORT=2333
set ONLY_READ=true
:: set WS_URL=wss://streamer-api.schwab.com/ws

echo Starting Go application...
go run main.go
```


### linux
```bash
#!/bin/bash

# envs
export SCHWAB_CLIENT_ID=""
export SCHWAB_CLIENT_SECRET=""
export PORT="2333"
export ONLY_READ="true"
# export WS_URL="wss://streamer-api.schwab.com/ws"

echo "Starting Go application..."
go run main.go
```

## Enable TLS

We recommend using [Caddy](https://github.com/caddyserver/caddy/releases) to run an HTTPS server,

### Create a Caddyfile file

Create a `Caddyfile` and enter the following code. Make sure that `access-control-allow-origin` is set to a trusted domain.

```
localhost:3333, 127.0.0.1:3333 {
    tls internal

    @options {
        method OPTIONS
    }
    respond @options 204
    
    header {
        >Access-Control-Allow-Origin "https://invmy.github.io"
        >Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS, PATCH"
        >Access-Control-Allow-Headers "Content-Type, Authorization, X-Requested-With, Access-Control-Request-Private-Network"
        >Access-Control-Max-Age "3600"
        >Access-Control-Allow-Private-Network "true"
    }

    reverse_proxy 127.0.0.1:2333
}
```

### start caddy
```
caddy run --config Caddyfile
```

You can now access it via `localhost:3333` or `127.0.0.1:3333`.