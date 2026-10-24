#ifndef RELAY_WEBSOCKETS_CLIENT_H
#define RELAY_WEBSOCKETS_CLIENT_H

#include <WebSocketsClient.h>
#include <WiFiClientSecure.h>
#include <new>

// Optional fixed-target TCP relay. The laptop forwards encrypted bytes only;
// the ESP still verifies Railway's certificate and original TLS hostname.
// Call configureRelay()/clearRelay() under the same mutex as loop()/sendBIN().
class RelayWebSocketsClient : public WebSocketsClient {
public:
    RelayWebSocketsClient() {
        _lastConnectionFail = 0;
        _client_cert = nullptr;
        _client_key = nullptr;
    }

    void configureRelay(IPAddress address, uint16_t port) {
        disconnect();
        relayAddress = address;
        relayPort = port;
        relayEnabled = true;
        _lastConnectionFail = 0;
    }

    void clearRelay() {
        disconnect();
        relayEnabled = false;
        relayPort = 0;
        _lastConnectionFail = 0;
    }

    void loop() {
        if (!relayEnabled) {
            WebSocketsClient::loop();
            return;
        }
        if (_port == 0) return; // beginSslWithCA() has not run yet.

        // A configured relay must never silently fall back to plaintext or to
        // an unverified connection, nor be reused for arbitrary destinations.
        if (!_client.isSSL || !_CA_cert || !_CA_cert[0] || _port != 443 ||
            _host != "elato-pyserver-production.up.railway.app" ||
            relayPort == 0 || !validRelayAddress()) {
            if (_client.tcp) clientDisconnect(&_client, "Invalid secure relay configuration");
            return;
        }

        WEBSOCKETS_YIELD();
        if (clientIsConnected(&_client)) {
            // Equivalent to the connected branch of WebSockets 2.7.3 loop().
            // Calling its full loop here could reconnect directly after a loss.
            handleClientData();
            WEBSOCKETS_YIELD();
            if (_client.status == WSC_CONNECTED) {
                handleHBPing();
                handleHBTimeout(&_client);
            }
            return;
        }

        if (millis() - _lastConnectionFail < _reconnectInterval) return;

        // clientIsConnected() has already disposed of a previous connection.
        _client.ssl = new (std::nothrow) WiFiClientSecure();
        if (!_client.ssl) {
            connectFailedCb();
            _lastConnectionFail = millis();
            return;
        }
        _client.tcp = _client.ssl;
        _client.ssl->setCACert(_CA_cert);
        if (_client_cert && _client_key) {
            _client.ssl->setCertificate(_client_cert);
            _client.ssl->setPrivateKey(_client_key);
        }
        // Arduino ESP32 2.x setTimeout() accepts seconds, not milliseconds.
        _client.ssl->setTimeout(5);
        _client.ssl->setHandshakeTimeout(20);

        // This public Arduino 2.x overload separates the TCP endpoint from the
        // TLS hostname. _host/_port also remain unchanged for the HTTP Host.
        if (_client.ssl->connect(relayAddress, relayPort, _host.c_str(),
                                 _CA_cert, _client_cert, _client_key)) {
            connectedCb();
            _lastConnectionFail = 0;
        } else {
            connectFailedCb();
            clientDisconnect(&_client, "Secure relay connection failed");
            _lastConnectionFail = millis();
        }
    }

private:
    bool validRelayAddress() const {
        // The relay must be another IPv4 host, not an unspecified, loopback,
        // multicast, or broadcast destination. Private LAN addresses are valid.
        return relayAddress[0] != 0 && relayAddress[0] != 127 &&
               relayAddress[0] < 224 &&
               static_cast<uint32_t>(relayAddress) != 0xFFFFFFFFUL;
    }

    IPAddress relayAddress;
    uint16_t relayPort = 0;
    bool relayEnabled = false;
};

#endif
