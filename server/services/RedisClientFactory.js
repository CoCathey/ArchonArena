const redis = require('redis');

class RedisClientFactory {
    constructor(configService) {
        this.configService = configService;
        const rawPrefix = configService.getValue('redisKeyPrefix') || '';
        this.prefix = rawPrefix ? rawPrefix + ':' : '';
    }

    createClient() {
        const client = redis.createClient({
            url: this.configService.getValue('redisUrl')
        });

        return this.wrapClient(client);
    }

    wrapClient(client) {
        const prefix = this.prefix;
        const originalGet = client.get.bind(client);
        const originalSet = client.set.bind(client);
        const originalPublish = client.publish.bind(client);
        const originalSubscribe = client.subscribe.bind(client);
        // ARCHON (N10): the durable outbox is a hash, and a hash key needs the
        // same prefix every other key gets. Wrapped here rather than prefixed
        // at the call site so a second instance sharing one Redis cannot read
        // the first one's queued game results.
        const originalHSet = client.hSet.bind(client);
        const originalHDel = client.hDel.bind(client);
        const originalHGetAll = client.hGetAll.bind(client);

        client.get = async function (key) {
            return originalGet(prefix + key);
        };

        client.set = async function (key, value, options) {
            return originalSet(prefix + key, value, options);
        };

        client.hSet = async function (key, field, value) {
            return originalHSet(prefix + key, field, value);
        };

        client.hDel = async function (key, field) {
            return originalHDel(prefix + key, field);
        };

        client.hGetAll = async function (key) {
            return originalHGetAll(prefix + key);
        };

        client.publish = async function (channel, message) {
            return originalPublish(prefix + channel, message);
        };

        client.subscribe = async function (channel, listener) {
            const wrappedListener = (message, originalChannel) => {
                const unprefixedChannel = originalChannel.startsWith(prefix)
                    ? originalChannel.substring(prefix.length)
                    : originalChannel;
                listener(message, unprefixedChannel);
            };
            return originalSubscribe(prefix + channel, wrappedListener);
        };

        return client;
    }
}

module.exports = RedisClientFactory;
