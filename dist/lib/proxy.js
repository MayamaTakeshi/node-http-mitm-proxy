"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Proxy = exports.gunzip = exports.wildcard = void 0;
const async_1 = __importDefault(require("async"));
const net_1 = __importDefault(require("net"));
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ws_1 = __importStar(require("ws"));
const url_1 = __importDefault(require("url"));
const semaphore_1 = __importDefault(require("semaphore"));
const ca_1 = __importDefault(require("./ca"));
const ProxyFinalResponseFilter_1 = require("./ProxyFinalResponseFilter");
const ProxyFinalRequestFilter_1 = require("./ProxyFinalRequestFilter");
const uuid_1 = require("uuid");
const gunzip_1 = __importDefault(require("./middleware/gunzip"));
exports.gunzip = gunzip_1.default;
const wildcard_1 = __importDefault(require("./middleware/wildcard"));
exports.wildcard = wildcard_1.default;
class Proxy {
    constructor() {
        this.connectRequests = {};
        this.sslSemaphores = {};
        this.sslServers = {};
        this.onConnectHandlers = [];
        this.onRequestHandlers = [];
        this.onRequestHeadersHandlers = [];
        this.onWebSocketConnectionHandlers = [];
        this.onWebSocketFrameHandlers = [];
        this.onWebSocketCloseHandlers = [];
        this.onWebSocketErrorHandlers = [];
        this.onErrorHandlers = [];
        this.onRequestDataHandlers = [];
        this.onRequestEndHandlers = [];
        this.onResponseHandlers = [];
        this.onResponseHeadersHandlers = [];
        this.onResponseDataHandlers = [];
        this.onResponseEndHandlers = [];
        this.responseContentPotentiallyModified = false;
    }
    listen(options, callback = () => undefined) {
        const self = this;
        this.options = options || {};
        this.httpPort = options.port || options.port === 0 ? options.port : 8080;
        this.httpHost = options.host || "localhost";
        this.timeout = options.timeout || 0;
        this.keepAlive = !!options.keepAlive;
        this.httpAgent =
            typeof options.httpAgent !== "undefined"
                ? options.httpAgent
                : new http_1.default.Agent({ keepAlive: this.keepAlive });
        this.httpsAgent =
            typeof options.httpsAgent !== "undefined"
                ? options.httpsAgent
                : new https_1.default.Agent({ keepAlive: this.keepAlive });
        this.forceSNI = !!options.forceSNI;
        if (this.forceSNI) {
            console.info("SNI enabled. Clients not supporting SNI may fail");
        }
        this.httpsPort = this.forceSNI ? options.httpsPort : undefined;
        this.sslCaDir =
            options.sslCaDir || path_1.default.resolve(process.cwd(), ".http-mitm-proxy");
        ca_1.default.create(this.sslCaDir, (err, ca) => {
            if (err) {
                return callback(err);
            }
            self.ca = ca;
            self.sslServers = {};
            self.sslSemaphores = {};
            self.connectRequests = {};
            self.httpServer = http_1.default.createServer();
            self.httpServer.timeout = self.timeout;
            self.httpServer.on("connect", self._onHttpServerConnect.bind(self));
            self.httpServer.on("request", self._onHttpServerRequest.bind(self, false));
            self.wsServer = new ws_1.WebSocketServer({ server: self.httpServer });
            self.wsServer.on("error", self._onError.bind(self, "HTTP_SERVER_ERROR", null));
            self.wsServer.on("connection", (ws, req) => {
                ws.upgradeReq = req;
                self._onWebSocketServerConnect.call(self, false, ws, req);
            });
            const listenOptions = {
                host: self.httpHost,
                port: self.httpPort,
            };
            if (self.forceSNI) {
                self._createHttpsServer({}, (port, httpsServer, wssServer) => {
                    console.debug(`https server started on ${port}`);
                    self.httpsServer = httpsServer;
                    self.wssServer = wssServer;
                    self.httpsPort = port;
                    self.httpServer.listen(listenOptions, () => {
                        self.httpPort = self.httpServer.address().port;
                        callback();
                    });
                });
            }
            else {
                self.httpServer.listen(listenOptions, () => {
                    self.httpPort = self.httpServer.address().port;
                    callback();
                });
            }
        });
        return this;
    }
    _createHttpsServer(options, callback) {
        const httpsServer = https_1.default.createServer({
            ...options,
        });
        httpsServer.timeout = this.timeout;
        httpsServer.on("error", this._onError.bind(this, "HTTPS_SERVER_ERROR", null));
        httpsServer.on("clientError", this._onError.bind(this, "HTTPS_CLIENT_ERROR", null));
        httpsServer.on("connect", this._onHttpServerConnect.bind(this));
        httpsServer.on("request", this._onHttpServerRequest.bind(this, true));
        const self = this;
        const wssServer = new ws_1.WebSocketServer({ server: httpsServer });
        wssServer.on("connection", (ws, req) => {
            ws.upgradeReq = req;
            self._onWebSocketServerConnect.call(self, true, ws, req);
        });
        const listenOptions = {
            port: 0,
            host: "0.0.0.0",
        };
        if (this.httpsPort && !options.hosts) {
            listenOptions.port = this.httpsPort;
        }
        if (this.httpHost) {
            listenOptions.host = this.httpHost;
        }
        httpsServer.listen(listenOptions, () => {
            if (callback) {
                callback(httpsServer.address().port, httpsServer, wssServer);
            }
        });
    }
    close() {
        this.httpServer.close();
        delete this.httpServer;
        if (this.httpsServer) {
            this.httpsServer.close();
            delete this.httpsServer;
            delete this.wssServer;
            this.sslServers = {};
        }
        if (this.sslServers) {
            for (const srvName of Object.keys(this.sslServers)) {
                const server = this.sslServers[srvName].server;
                if (server) {
                    server.close();
                }
                delete this.sslServers[srvName];
            }
        }
        return this;
    }
    onError(fn) {
        this.onErrorHandlers.push(fn);
        return this;
    }
    onConnect(fn) {
        this.onConnectHandlers.push(fn);
        return this;
    }
    onRequestHeaders(fn) {
        this.onRequestHeadersHandlers.push(fn);
        return this;
    }
    onRequest(fn) {
        this.onRequestHandlers.push(fn);
        return this;
    }
    onWebSocketConnection(fn) {
        this.onWebSocketConnectionHandlers.push(fn);
        return this;
    }
    onWebSocketSend(fn) {
        this.onWebSocketFrameHandlers.push(function (ctx, type, fromServer, data, flags, callback) {
            if (!fromServer && type === "message") {
                return this(ctx, data, flags, callback);
            }
            else {
                callback(null, data, flags);
            }
        }.bind(fn));
        return this;
    }
    onWebSocketMessage(fn) {
        this.onWebSocketFrameHandlers.push(function (ctx, type, fromServer, data, flags, callback) {
            if (fromServer && type === "message") {
                return this(ctx, data, flags, callback);
            }
            else {
                callback(null, data, flags);
            }
        }.bind(fn));
        return this;
    }
    onWebSocketFrame(fn) {
        this.onWebSocketFrameHandlers.push(fn);
        return this;
    }
    onWebSocketClose(fn) {
        this.onWebSocketCloseHandlers.push(fn);
        return this;
    }
    onWebSocketError(fn) {
        this.onWebSocketErrorHandlers.push(fn);
        return this;
    }
    onRequestData(fn) {
        this.onRequestDataHandlers.push(fn);
        return this;
    }
    onRequestEnd(fn) {
        this.onRequestEndHandlers.push(fn);
        return this;
    }
    onResponse(fn) {
        this.onResponseHandlers.push(fn);
        return this;
    }
    onResponseHeaders(fn) {
        this.onResponseHeadersHandlers.push(fn);
        return this;
    }
    onResponseData(fn) {
        this.onResponseDataHandlers.push(fn);
        this.responseContentPotentiallyModified = true;
        return this;
    }
    onResponseEnd(fn) {
        this.onResponseEndHandlers.push(fn);
        return this;
    }
    use(mod) {
        if (mod.onError) {
            this.onError(mod.onError);
        }
        if (mod.onCertificateRequired) {
            this.onCertificateRequired = mod.onCertificateRequired;
        }
        if (mod.onCertificateMissing) {
            this.onCertificateMissing = mod.onCertificateMissing;
        }
        if (mod.onConnect) {
            this.onConnect(mod.onConnect);
        }
        if (mod.onRequest) {
            this.onRequest(mod.onRequest);
        }
        if (mod.onRequestHeaders) {
            this.onRequestHeaders(mod.onRequestHeaders);
        }
        if (mod.onRequestData) {
            this.onRequestData(mod.onRequestData);
        }
        if (mod.onResponse) {
            this.onResponse(mod.onResponse);
        }
        if (mod.onResponseHeaders) {
            this.onResponseHeaders(mod.onResponseHeaders);
        }
        if (mod.onResponseData) {
            this.onResponseData(mod.onResponseData);
        }
        if (mod.onWebSocketConnection) {
            this.onWebSocketConnection(mod.onWebSocketConnection);
        }
        if (mod.onWebSocketSend) {
            this.onWebSocketFrame(function (ctx, type, fromServer, data, flags, callback) {
                if (!fromServer && type === "message") {
                    return this(ctx, data, flags, callback);
                }
                else {
                    callback(null, data, flags);
                }
            }.bind(mod.onWebSocketSend));
        }
        if (mod.onWebSocketMessage) {
            this.onWebSocketFrame(function (ctx, type, fromServer, data, flags, callback) {
                if (fromServer && type === "message") {
                    return this(ctx, data, flags, callback);
                }
                else {
                    callback(null, data, flags);
                }
            }.bind(mod.onWebSocketMessage));
        }
        if (mod.onWebSocketFrame) {
            this.onWebSocketFrame(mod.onWebSocketFrame);
        }
        if (mod.onWebSocketClose) {
            this.onWebSocketClose(mod.onWebSocketClose);
        }
        if (mod.onWebSocketError) {
            this.onWebSocketError(mod.onWebSocketError);
        }
        return this;
    }
    _onSocketError(socketDescription, err) {
        if (err.errno === -54 || err.code === "ECONNRESET") {
            console.debug(`Got ECONNRESET on ${socketDescription}, ignoring.`);
        }
        else {
            this._onError(`${socketDescription}_ERROR`, null, err);
        }
    }
    _onHttpServerConnect(req, socket, head) {
        const self = this;
        socket.on("error", self._onSocketError.bind(self, "CLIENT_TO_PROXY_SOCKET"));
        return async_1.default.forEach(self.onConnectHandlers, (fn, callback) => fn.call(self, req, socket, head, callback), (err) => {
            if (err) {
                return self._onError("ON_CONNECT_ERROR", null, err);
            }
            if (!head || head.length === 0) {
                socket.once("data", self._onHttpServerConnectData.bind(self, req, socket));
                socket.write("HTTP/1.1 200 OK\r\n");
                if (self.keepAlive &&
                    req.headers["proxy-connection"] === "keep-alive") {
                    socket.write("Proxy-Connection: keep-alive\r\n");
                    socket.write("Connection: keep-alive\r\n");
                }
                return socket.write("\r\n");
            }
            else {
                self._onHttpServerConnectData(req, socket, head);
            }
        });
    }
    _onHttpServerConnectData(req, socket, head) {
        const self = this;
        socket.pause();
        function makeConnection(port) {
            const conn = net_1.default.connect({
                port,
                host: "0.0.0.0",
                allowHalfOpen: true,
            }, () => {
                const connectKey = `${conn.localPort}:${conn.remotePort}`;
                self.connectRequests[connectKey] = req;
                const cleanupFunction = () => {
                    delete self.connectRequests[connectKey];
                };
                conn.on("close", () => {
                    cleanupFunction();
                    socket.destroy();
                });
                socket.on("close", () => {
                    conn.destroy();
                });
                conn.on("error", (err) => {
                    console.error("Connection error:");
                    console.error(err);
                    conn.destroy();
                });
                socket.on("error", (err) => {
                    console.error("Socket error:");
                    console.error(err);
                });
                socket.pipe(conn);
                conn.pipe(socket);
                socket.emit("data", head);
                return socket.resume();
            });
            conn.on("error", self._onSocketError.bind(self, "PROXY_TO_PROXY_SOCKET"));
        }
        function getHttpsServer(hostname, callback) {
            self.onCertificateRequired(hostname, (err, files) => {
                if (err) {
                    return callback(err);
                }
                const httpsOptions = [
                    "keyFileExists",
                    "certFileExists",
                    (data, callback) => {
                        if (data.keyFileExists && data.certFileExists) {
                            return fs_1.default.readFile(files.keyFile, (err, keyFileData) => {
                                if (err) {
                                    return callback(err);
                                }
                                return fs_1.default.readFile(files.certFile, (err, certFileData) => {
                                    if (err) {
                                        return callback(err);
                                    }
                                    return callback(null, {
                                        key: keyFileData,
                                        cert: certFileData,
                                        hosts: files.hosts,
                                    });
                                });
                            });
                        }
                        else {
                            const ctx = {
                                hostname,
                                files,
                                data,
                            };
                            return self.onCertificateMissing(ctx, files, (err, files) => {
                                if (err) {
                                    return callback(err);
                                }
                                return callback(null, {
                                    key: files.keyFileData,
                                    cert: files.certFileData,
                                    hosts: files.hosts,
                                });
                            });
                        }
                    },
                ];
                async_1.default.auto({
                    keyFileExists(callback) {
                        return fs_1.default.exists(files.keyFile, (exists) => callback(null, exists));
                    },
                    certFileExists(callback) {
                        return fs_1.default.exists(files.certFile, (exists) => callback(null, exists));
                    },
                    httpsOptions,
                }, (err, results) => {
                    if (err) {
                        return callback(err);
                    }
                    let hosts;
                    if (results.httpsOptions &&
                        results.httpsOptions.hosts &&
                        results.httpsOptions.hosts.length) {
                        hosts = results.httpsOptions.hosts;
                        if (!hosts.includes(hostname)) {
                            hosts.push(hostname);
                        }
                    }
                    else {
                        hosts = [hostname];
                    }
                    delete results.httpsOptions.hosts;
                    if (self.forceSNI && !hostname.match(/^[\d.]+$/)) {
                        console.debug(`creating SNI context for ${hostname}`);
                        hosts.forEach((host) => {
                            self.httpsServer.addContext(host, results.httpsOptions);
                            self.sslServers[host] = { port: Number(self.httpsPort) };
                        });
                        return callback(null, self.httpsPort);
                    }
                    else {
                        console.debug(`starting server for ${hostname}`);
                        results.httpsOptions.hosts = hosts;
                        try {
                            self._createHttpsServer(results.httpsOptions, (port, httpsServer, wssServer) => {
                                console.debug(`https server started for ${hostname} on ${port}`);
                                const sslServer = {
                                    server: httpsServer,
                                    wsServer: wssServer,
                                    port,
                                };
                                hosts.forEach((host) => {
                                    self.sslServers[host] = sslServer;
                                });
                                return callback(null, port);
                            });
                        }
                        catch (err) {
                            return callback(err);
                        }
                    }
                });
            });
        }
        if (head[0] == 0x16 || head[0] == 0x80 || head[0] == 0x00) {
            const hostname = req.url.split(":", 2)[0];
            const sslServer = this.sslServers[hostname];
            if (sslServer) {
                return makeConnection(sslServer.port);
            }
            const wildcardHost = hostname.replace(/[^.]+\./, "*.");
            let sem = self.sslSemaphores[wildcardHost];
            if (!sem) {
                sem = self.sslSemaphores[wildcardHost] = (0, semaphore_1.default)(1);
            }
            sem.take(() => {
                if (self.sslServers[hostname]) {
                    process.nextTick(sem.leave.bind(sem));
                    return makeConnection(self.sslServers[hostname].port);
                }
                if (self.sslServers[wildcardHost]) {
                    process.nextTick(sem.leave.bind(sem));
                    self.sslServers[hostname] = {
                        port: self.sslServers[wildcardHost].port,
                    };
                    return makeConnection(self.sslServers[hostname].port);
                }
                getHttpsServer(hostname, (err, port) => {
                    process.nextTick(sem.leave.bind(sem));
                    if (err) {
                        console.error("Error getting HTTPs server");
                        console.error(err);
                        return self._onError("OPEN_HTTPS_SERVER_ERROR", null, err);
                    }
                    return makeConnection(port);
                });
                delete self.sslSemaphores[wildcardHost];
            });
        }
        else {
            return makeConnection(this.httpPort);
        }
    }
    onCertificateRequired(hostname, callback) {
        const self = this;
        return callback(null, {
            keyFile: `${self.sslCaDir}/keys/${hostname}.key`,
            certFile: `${self.sslCaDir}/certs/${hostname}.pem`,
            hosts: [hostname],
        });
    }
    onCertificateMissing(ctx, files, callback) {
        const hosts = files.hosts || [ctx.hostname];
        this.ca.generateServerCertificateKeys(hosts, (certPEM, privateKeyPEM) => {
            callback(null, {
                certFileData: certPEM,
                keyFileData: privateKeyPEM,
                hosts,
            });
        });
    }
    _onError(kind, ctx, err) {
        console.error(kind);
        console.error(err);
        this.onErrorHandlers.forEach((handler) => handler(ctx, err, kind));
        if (ctx) {
            ctx.onErrorHandlers.forEach((handler) => handler(ctx, err, kind));
            if (ctx.proxyToClientResponse && !ctx.proxyToClientResponse.headersSent) {
                ctx.proxyToClientResponse.writeHead(504, "Proxy Error");
            }
            if (ctx.proxyToClientResponse && !ctx.proxyToClientResponse.finished) {
                ctx.proxyToClientResponse.end(`${kind}: ${err}`, "utf8");
            }
        }
    }
    _onWebSocketServerConnect(isSSL, ws, upgradeReq) {
        const self = this;
        const socket = ws._socket;
        const ctx = {
            uuid: (0, uuid_1.v4)(),
            proxyToServerWebSocketOptions: undefined,
            proxyToServerWebSocket: undefined,
            isSSL,
            connectRequest: self.connectRequests[`${socket.remotePort}:${socket.localPort}`],
            clientToProxyWebSocket: ws,
            onWebSocketConnectionHandlers: [],
            onWebSocketFrameHandlers: [],
            onWebSocketCloseHandlers: [],
            onWebSocketErrorHandlers: [],
            onWebSocketConnection(fn) {
                ctx.onWebSocketConnectionHandlers.push(fn);
                return ctx;
            },
            onWebSocketSend(fn) {
                ctx.onWebSocketFrameHandlers.push(function (ctx, type, fromServer, data, flags, callback) {
                    if (!fromServer && type === "message") {
                        return this(ctx, data, flags, callback);
                    }
                    else {
                        callback(null, data, flags);
                    }
                }.bind(fn));
                return ctx;
            },
            onWebSocketMessage(fn) {
                ctx.onWebSocketFrameHandlers.push(function (ctx, type, fromServer, data, flags, callback) {
                    if (fromServer && type === "message") {
                        return this(ctx, data, flags, callback);
                    }
                    else {
                        callback(null, data, flags);
                    }
                }.bind(fn));
                return ctx;
            },
            onWebSocketFrame(fn) {
                ctx.onWebSocketFrameHandlers.push(fn);
                return ctx;
            },
            onWebSocketClose(fn) {
                ctx.onWebSocketCloseHandlers.push(fn);
                return ctx;
            },
            onWebSocketError(fn) {
                ctx.onWebSocketErrorHandlers.push(fn);
                return ctx;
            },
            use(mod) {
                if (mod.onWebSocketConnection) {
                    ctx.onWebSocketConnection(mod.onWebSocketConnection);
                }
                if (mod.onWebSocketSend) {
                    ctx.onWebSocketFrame(function (ctx, type, fromServer, data, flags, callback) {
                        if (!fromServer && type === "message") {
                            return this(ctx, data, flags, callback);
                        }
                        else {
                            callback(null, data, flags);
                        }
                    }.bind(mod.onWebSocketSend));
                }
                if (mod.onWebSocketMessage) {
                    ctx.onWebSocketFrame(function (ctx, type, fromServer, data, flags, callback) {
                        if (fromServer && type === "message") {
                            return this(ctx, data, flags, callback);
                        }
                        else {
                            callback(null, data, flags);
                        }
                    }.bind(mod.onWebSocketMessage));
                }
                if (mod.onWebSocketFrame) {
                    ctx.onWebSocketFrame(mod.onWebSocketFrame);
                }
                if (mod.onWebSocketClose) {
                    ctx.onWebSocketClose(mod.onWebSocketClose);
                }
                if (mod.onWebSocketError) {
                    ctx.onWebSocketError(mod.onWebSocketError);
                }
                return ctx;
            },
        };
        const clientToProxyWebSocket = ctx.clientToProxyWebSocket;
        clientToProxyWebSocket.on("message", self._onWebSocketFrame.bind(self, ctx, "message", false));
        clientToProxyWebSocket.on("ping", self._onWebSocketFrame.bind(self, ctx, "ping", false));
        clientToProxyWebSocket.on("pong", self._onWebSocketFrame.bind(self, ctx, "pong", false));
        clientToProxyWebSocket.on("error", self._onWebSocketError.bind(self, ctx));
        clientToProxyWebSocket._socket.on("error", self._onWebSocketError.bind(self, ctx));
        clientToProxyWebSocket.on("close", self._onWebSocketClose.bind(self, ctx, false));
        clientToProxyWebSocket._socket.pause();
        let url;
        if (upgradeReq.url == "" || /^\//.test(upgradeReq.url)) {
            const hostPort = Proxy.parseHostAndPort(upgradeReq);
            const prefix = ctx.isSSL ? "wss" : "ws";
            const port = hostPort.port ? ":" + hostPort.port : "";
            url = `${prefix}://${hostPort.host}${port}${upgradeReq.url}`;
        }
        else {
            url = upgradeReq.url;
        }
        const ptosHeaders = {};
        const ctopHeaders = upgradeReq.headers;
        for (const key in ctopHeaders) {
            if (key.indexOf("sec-websocket") !== 0) {
                ptosHeaders[key] = ctopHeaders[key];
            }
        }
        ctx.proxyToServerWebSocketOptions = {
            url,
            agent: ctx.isSSL ? self.httpsAgent : self.httpAgent,
            headers: ptosHeaders,
        };
        function makeProxyToServerWebSocket() {
            ctx.proxyToServerWebSocket = new ws_1.default(ctx.proxyToServerWebSocketOptions.url, ctx.proxyToServerWebSocketOptions);
            ctx.proxyToServerWebSocket.on("message", self._onWebSocketFrame.bind(self, ctx, "message", true));
            ctx.proxyToServerWebSocket.on("ping", self._onWebSocketFrame.bind(self, ctx, "ping", true));
            ctx.proxyToServerWebSocket.on("pong", self._onWebSocketFrame.bind(self, ctx, "pong", true));
            ctx.proxyToServerWebSocket.on("error", self._onWebSocketError.bind(self, ctx));
            ctx.proxyToServerWebSocket.on("close", self._onWebSocketClose.bind(self, ctx, true));
            ctx.proxyToServerWebSocket.on("open", () => {
                ctx.proxyToServerWebSocket._socket.on("error", self._onWebSocketError.bind(self, ctx));
                if (clientToProxyWebSocket.readyState === ws_1.default.OPEN) {
                    clientToProxyWebSocket._socket.resume();
                }
            });
        }
        return self._onWebSocketConnection(ctx, (err) => {
            if (err) {
                return self._onWebSocketError(ctx, err);
            }
            return makeProxyToServerWebSocket();
        });
    }
    _onHttpServerRequest(isSSL, clientToProxyRequest, proxyToClientResponse) {
        const self = this;
        const ctx = {
            uuid: (0, uuid_1.v4)(),
            isSSL,
            serverToProxyResponse: undefined,
            proxyToServerRequestOptions: undefined,
            proxyToServerRequest: undefined,
            connectRequest: self.connectRequests[`${clientToProxyRequest.socket.remotePort}:${clientToProxyRequest.socket.localPort}`] || undefined,
            clientToProxyRequest,
            proxyToClientResponse,
            onRequestHandlers: [],
            onErrorHandlers: [],
            onRequestDataHandlers: [],
            onResponseHeadersHandlers: [],
            onRequestHeadersHandlers: [],
            onRequestEndHandlers: [],
            onResponseHandlers: [],
            onResponseDataHandlers: [],
            onResponseEndHandlers: [],
            requestFilters: [],
            responseFilters: [],
            responseContentPotentiallyModified: false,
            onRequest(fn) {
                ctx.onRequestHandlers.push(fn);
                return ctx;
            },
            onError(fn) {
                ctx.onErrorHandlers.push(fn);
                return ctx;
            },
            onRequestData(fn) {
                ctx.onRequestDataHandlers.push(fn);
                return ctx;
            },
            onRequestHeaders(fn) {
                ctx.onRequestHeadersHandlers.push(fn);
                return ctx;
            },
            onResponseHeaders(fn) {
                ctx.onResponseHeadersHandlers.push(fn);
                return ctx;
            },
            onRequestEnd(fn) {
                ctx.onRequestEndHandlers.push(fn);
                return ctx;
            },
            addRequestFilter(filter) {
                ctx.requestFilters.push(filter);
                return ctx;
            },
            onResponse(fn) {
                ctx.onResponseHandlers.push(fn);
                return ctx;
            },
            onResponseData(fn) {
                ctx.onResponseDataHandlers.push(fn);
                ctx.responseContentPotentiallyModified = true;
                return ctx;
            },
            onResponseEnd(fn) {
                ctx.onResponseEndHandlers.push(fn);
                return ctx;
            },
            addResponseFilter(filter) {
                ctx.responseFilters.push(filter);
                ctx.responseContentPotentiallyModified = true;
                return ctx;
            },
            use(mod) {
                if (mod.onError) {
                    ctx.onError(mod.onError);
                }
                if (mod.onRequest) {
                    ctx.onRequest(mod.onRequest);
                }
                if (mod.onRequestHeaders) {
                    ctx.onRequestHeaders(mod.onRequestHeaders);
                }
                if (mod.onRequestData) {
                    ctx.onRequestData(mod.onRequestData);
                }
                if (mod.onResponse) {
                    ctx.onResponse(mod.onResponse);
                }
                if (mod.onResponseData) {
                    ctx.onResponseData(mod.onResponseData);
                }
                return ctx;
            },
        };
        ctx.clientToProxyRequest.on("error", self._onError.bind(self, "CLIENT_TO_PROXY_REQUEST_ERROR", ctx));
        ctx.proxyToClientResponse.on("error", self._onError.bind(self, "PROXY_TO_CLIENT_RESPONSE_ERROR", ctx));
        ctx.clientToProxyRequest.pause();
        const hostPort = Proxy.parseHostAndPort(ctx.clientToProxyRequest, ctx.isSSL ? 443 : 80);
        function proxyToServerRequestComplete(serverToProxyResponse) {
            serverToProxyResponse.on("error", self._onError.bind(self, "SERVER_TO_PROXY_RESPONSE_ERROR", ctx));
            serverToProxyResponse.pause();
            ctx.serverToProxyResponse = serverToProxyResponse;
            return self._onResponse(ctx, (err) => {
                if (err) {
                    return self._onError("ON_RESPONSE_ERROR", ctx, err);
                }
                const servToProxyResp = ctx.serverToProxyResponse;
                if (self.responseContentPotentiallyModified ||
                    ctx.responseContentPotentiallyModified) {
                    servToProxyResp.headers["transfer-encoding"] = "chunked";
                    delete servToProxyResp.headers["content-length"];
                }
                if (self.keepAlive) {
                    if (ctx.clientToProxyRequest.headers["proxy-connection"]) {
                        servToProxyResp.headers["proxy-connection"] = "keep-alive";
                        servToProxyResp.headers["connection"] = "keep-alive";
                    }
                }
                else {
                    servToProxyResp.headers["connection"] = "close";
                }
                return self._onResponseHeaders(ctx, (err) => {
                    if (err) {
                        return self._onError("ON_RESPONSEHEADERS_ERROR", ctx, err);
                    }
                    ctx.proxyToClientResponse.writeHead(servToProxyResp.statusCode, Proxy.filterAndCanonizeHeaders(servToProxyResp.headers));
                    ctx.responseFilters.push(new ProxyFinalResponseFilter_1.ProxyFinalResponseFilter(self, ctx));
                    let prevResponsePipeElem = servToProxyResp;
                    ctx.responseFilters.forEach((filter) => {
                        filter.on("error", self._onError.bind(self, "RESPONSE_FILTER_ERROR", ctx));
                        prevResponsePipeElem = prevResponsePipeElem.pipe(filter);
                    });
                    return servToProxyResp.resume();
                });
            });
        }
        function makeProxyToServerRequest() {
            const proto = ctx.isSSL ? https_1.default : http_1.default;
            ctx.proxyToServerRequest = proto.request(ctx.proxyToServerRequestOptions, proxyToServerRequestComplete);
            ctx.proxyToServerRequest.on("error", self._onError.bind(self, "PROXY_TO_SERVER_REQUEST_ERROR", ctx));
            ctx.requestFilters.push(new ProxyFinalRequestFilter_1.ProxyFinalRequestFilter(self, ctx));
            let prevRequestPipeElem = ctx.clientToProxyRequest;
            ctx.requestFilters.forEach((filter) => {
                filter.on("error", self._onError.bind(self, "REQUEST_FILTER_ERROR", ctx));
                prevRequestPipeElem = prevRequestPipeElem.pipe(filter);
            });
            ctx.clientToProxyRequest.resume();
        }
        if (hostPort === null) {
            ctx.clientToProxyRequest.resume();
            ctx.proxyToClientResponse.writeHead(400, {
                "Content-Type": "text/html; charset=utf-8",
            });
            ctx.proxyToClientResponse.end("Bad request: Host missing...", "utf-8");
        }
        else {
            const headers = {};
            for (const h in ctx.clientToProxyRequest.headers) {
                if (!/^proxy-/i.test(h)) {
                    headers[h] = ctx.clientToProxyRequest.headers[h];
                }
            }
            if (this.options.forceChunkedRequest) {
                delete headers["content-length"];
            }
            ctx.proxyToServerRequestOptions = {
                method: ctx.clientToProxyRequest.method,
                path: ctx.clientToProxyRequest.url,
                host: hostPort.host,
                port: hostPort.port,
                headers,
                agent: ctx.isSSL ? self.httpsAgent : self.httpAgent,
            };
            return self._onRequest(ctx, (err) => {
                if (err) {
                    return self._onError("ON_REQUEST_ERROR", ctx, err);
                }
                return self._onRequestHeaders(ctx, (err) => {
                    if (err) {
                        return self._onError("ON_REQUESTHEADERS_ERROR", ctx, err);
                    }
                    return makeProxyToServerRequest();
                });
            });
        }
    }
    _onRequestHeaders(ctx, callback) {
        async_1.default.forEach(this.onRequestHeadersHandlers, (fn, callback) => fn(ctx, callback), callback);
    }
    _onRequest(ctx, callback) {
        async_1.default.forEach(this.onRequestHandlers.concat(ctx.onRequestHandlers), (fn, callback) => fn(ctx, callback), callback);
    }
    _onWebSocketConnection(ctx, callback) {
        async_1.default.forEach(this.onWebSocketConnectionHandlers.concat(ctx.onWebSocketConnectionHandlers), (fn, callback) => fn(ctx, callback), callback);
    }
    _onWebSocketFrame(ctx, type, fromServer, data, flags) {
        const self = this;
        async_1.default.forEach(this.onWebSocketFrameHandlers.concat(ctx.onWebSocketFrameHandlers), (fn, callback) => fn(ctx, type, fromServer, data, flags, (err, newData, newFlags) => {
            if (err) {
                return callback(err);
            }
            data = newData;
            flags = newFlags;
            return callback(null, data, flags);
        }), (err) => {
            if (err) {
                return self._onWebSocketError(ctx, err);
            }
            const destWebSocket = fromServer
                ? ctx.clientToProxyWebSocket
                : ctx.proxyToServerWebSocket;
            if (destWebSocket.readyState === ws_1.default.OPEN) {
                switch (type) {
                    case "message":
                        destWebSocket.send(data, { binary: flags });
                        break;
                    case "ping":
                        destWebSocket.ping(data, flags);
                        break;
                    case "pong":
                        destWebSocket.pong(data, flags);
                        break;
                }
            }
            else {
                self._onWebSocketError(ctx, new Error(`Cannot send ${type} because ${fromServer ? "clientToProxy" : "proxyToServer"} WebSocket connection state is not OPEN`));
            }
        });
    }
    _onWebSocketClose(ctx, closedByServer, code, message) {
        const self = this;
        if (!ctx.closedByServer && !ctx.closedByClient) {
            ctx.closedByServer = closedByServer;
            ctx.closedByClient = !closedByServer;
            async_1.default.forEach(this.onWebSocketCloseHandlers.concat(ctx.onWebSocketCloseHandlers), (fn, callback) => fn(ctx, code, message, callback), (err) => {
                if (err) {
                    return self._onWebSocketError(ctx, err);
                }
                const clientToProxyWebSocket = ctx.clientToProxyWebSocket;
                const proxyToServerWebSocket = ctx.proxyToServerWebSocket;
                if (clientToProxyWebSocket.readyState !==
                    proxyToServerWebSocket.readyState) {
                    try {
                        if (clientToProxyWebSocket.readyState === ws_1.default.CLOSED &&
                            proxyToServerWebSocket.readyState === ws_1.default.OPEN) {
                            code === 1005
                                ? proxyToServerWebSocket.close()
                                : proxyToServerWebSocket.close(code, message);
                        }
                        else if (proxyToServerWebSocket.readyState === ws_1.default.CLOSED &&
                            clientToProxyWebSocket.readyState === ws_1.default.OPEN) {
                            code === 1005
                                ? proxyToServerWebSocket.close()
                                : clientToProxyWebSocket.close(code, message);
                        }
                    }
                    catch (err) {
                        return self._onWebSocketError(ctx, err);
                    }
                }
            });
        }
    }
    _onWebSocketError(ctx, err) {
        this.onWebSocketErrorHandlers.forEach((handler) => handler(ctx, err));
        if (ctx) {
            ctx.onWebSocketErrorHandlers.forEach((handler) => handler(ctx, err));
        }
        const clientToProxyWebSocket = ctx.clientToProxyWebSocket;
        const proxyToServerWebSocket = ctx.proxyToServerWebSocket;
        if (proxyToServerWebSocket &&
            clientToProxyWebSocket.readyState !== proxyToServerWebSocket.readyState) {
            try {
                if (clientToProxyWebSocket.readyState === ws_1.default.CLOSED &&
                    proxyToServerWebSocket.readyState === ws_1.default.OPEN) {
                    proxyToServerWebSocket.close();
                }
                else if (proxyToServerWebSocket.readyState === ws_1.default.CLOSED &&
                    clientToProxyWebSocket.readyState === ws_1.default.OPEN) {
                    clientToProxyWebSocket.close();
                }
            }
            catch (err) {
            }
        }
    }
    _onRequestData(ctx, chunk, callback) {
        const self = this;
        async_1.default.forEach(this.onRequestDataHandlers.concat(ctx.onRequestDataHandlers), (fn, callback) => fn(ctx, chunk, (err, newChunk) => {
            if (err) {
                return callback(err);
            }
            chunk = newChunk;
            return callback(null, newChunk);
        }), (err) => {
            if (err) {
                return self._onError("ON_REQUEST_DATA_ERROR", ctx, err);
            }
            return callback(null, chunk);
        });
    }
    _onRequestEnd(ctx, callback) {
        const self = this;
        async_1.default.forEach(this.onRequestEndHandlers.concat(ctx.onRequestEndHandlers), (fn, callback) => fn(ctx, callback), (err) => {
            if (err) {
                return self._onError("ON_REQUEST_END_ERROR", ctx, err);
            }
            return callback(null);
        });
    }
    _onResponse(ctx, callback) {
        async_1.default.forEach(this.onResponseHandlers.concat(ctx.onResponseHandlers), (fn, callback) => fn(ctx, callback), callback);
    }
    _onResponseHeaders(ctx, callback) {
        async_1.default.forEach(this.onResponseHeadersHandlers, (fn, callback) => fn(ctx, callback), callback);
    }
    _onResponseData(ctx, chunk, callback) {
        async_1.default.forEach(this.onResponseDataHandlers.concat(ctx.onResponseDataHandlers), (fn, callback) => fn(ctx, chunk, (err, newChunk) => {
            if (err) {
                return callback(err);
            }
            chunk = newChunk;
            return callback(null, newChunk);
        }), (err) => {
            if (err) {
                return this._onError("ON_RESPONSE_DATA_ERROR", ctx, err);
            }
            return callback(null, chunk);
        });
    }
    _onResponseEnd(ctx, callback) {
        async_1.default.forEach(this.onResponseEndHandlers.concat(ctx.onResponseEndHandlers), (fn, callback) => fn(ctx, callback), (err) => {
            if (err) {
                return this._onError("ON_RESPONSE_END_ERROR", ctx, err);
            }
            return callback(null);
        });
    }
    static parseHostAndPort(req, defaultPort) {
        const m = req.url.match(/^http:\/\/([^/]+)(.*)/);
        if (m) {
            req.url = m[2] || "/";
            return Proxy.parseHost(m[1], defaultPort);
        }
        else if (req.headers.host) {
            return Proxy.parseHost(req.headers.host, defaultPort);
        }
        else {
            return null;
        }
    }
    static parseHost(hostString, defaultPort) {
        const m = hostString.match(/^http:\/\/(.*)/);
        if (m) {
            const parsedUrl = url_1.default.parse(hostString);
            return {
                host: parsedUrl.hostname,
                port: Number(parsedUrl.port),
            };
        }
        const hostPort = hostString.split(":");
        const host = hostPort[0];
        const port = hostPort.length === 2 ? +hostPort[1] : defaultPort;
        return {
            host,
            port,
        };
    }
    static filterAndCanonizeHeaders(originalHeaders) {
        const headers = {};
        for (const key in originalHeaders) {
            const canonizedKey = key.trim();
            if (/^public-key-pins/i.test(canonizedKey)) {
                continue;
            }
            headers[canonizedKey] = originalHeaders[key];
        }
        return headers;
    }
}
exports.Proxy = Proxy;
Proxy.wildcard = wildcard_1.default;
Proxy.gunzip = gunzip_1.default;
//# sourceMappingURL=proxy.js.map