require('dotenv').config();
const Redis = require('ioredis');

// Bộ lưu trữ Key-Value có TTL thật trong RAM (Fallback khi máy chưa bật Docker Redis)
const memStore = new Map(); // key -> { value: string, expireAt: number | null }
const streamStore = new Map(); // key -> Array<{ id: string, fields: string[] }>
const streamWaiters = new Map(); // key -> Array<{ resolve: Function, minId: string, timer: any }>
let streamSeq = 0;
let activeClientsCount = 1;

function cleanExpired(key) {
  const item = memStore.get(key);
  if (item && item.expireAt !== null && Date.now() >= item.expireAt) {
    memStore.delete(key);
    return null;
  }
  return item || null;
}

const fallbackRedis = {
  get: async (key) => {
    const item = cleanExpired(key);
    return item ? String(item.value) : null;
  },
  set: async (key, value, mode, duration) => {
    let expireAt = null;
    if (mode && String(mode).toUpperCase() === 'EX' && duration) {
      expireAt = Date.now() + Number(duration) * 1000;
    }
    memStore.set(key, { value: String(value), expireAt });
    return 'OK';
  },
  incr: async (key) => {
    const item = cleanExpired(key);
    if (!item) {
      memStore.set(key, { value: '1', expireAt: null });
      return 1;
    }
    const nextVal = (Number(item.value) || 0) + 1;
    item.value = String(nextVal);
    return nextVal;
  },
  expire: async (key, seconds) => {
    const item = cleanExpired(key);
    if (!item) return 0;
    item.expireAt = Date.now() + Number(seconds) * 1000;
    return 1;
  },
  ttl: async (key) => {
    const item = cleanExpired(key);
    if (!item) return -2;
    if (item.expireAt === null) return -1;
    return Math.max(0, Math.ceil((item.expireAt - Date.now()) / 1000));
  },
  del: async (...keys) => {
    let deleted = 0;
    for (const k of keys) {
      if (memStore.delete(k)) deleted++;
    }
    return deleted;
  },
  unlink: async (...keys) => {
    let deleted = 0;
    for (const k of keys) {
      if (memStore.delete(k)) deleted++;
    }
    return deleted;
  },
  mget: async (...keys) => {
    const flat = keys.flat();
    const res = [];
    for (const k of flat) {
      res.push(await fallbackRedis.get(k));
    }
    return res;
  },
  scan: async (cursor = '0', ...args) => {
    let matchPattern = null;
    let count = 10;
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] === 'string' && args[i].toUpperCase() === 'MATCH') {
        matchPattern = args[i + 1];
        i++;
      } else if (typeof args[i] === 'string' && args[i].toUpperCase() === 'COUNT') {
        count = Number(args[i + 1]) || 10;
        i++;
      }
    }

    const allKeys = Array.from(memStore.keys()).filter(k => cleanExpired(k));
    let matchedKeys = allKeys;
    if (matchPattern) {
      const prefix = matchPattern.replace('*', '');
      matchedKeys = allKeys.filter(k => k.startsWith(prefix));
    }

    const curIndex = Number(cursor) || 0;
    const slice = matchedKeys.slice(curIndex, curIndex + count);
    const nextCursor = (curIndex + count >= matchedKeys.length) ? '0' : String(curIndex + count);
    return [nextCursor, slice];
  },
  keys: async (pattern) => {
    const prefix = pattern.replace('*', '');
    const matched = [];
    for (const k of Array.from(memStore.keys())) {
      if (cleanExpired(k) && k.startsWith(prefix)) {
        matched.push(k);
      }
    }
    return matched;
  },
  sadd: async (key, ...members) => {
    let item = cleanExpired(key);
    if (!item || !(item.value instanceof Set)) {
      item = { value: new Set(), expireAt: item ? item.expireAt : null };
      memStore.set(key, item);
    }
    let added = 0;
    for (const m of members) {
      const s = String(m);
      if (!item.value.has(s)) {
        item.value.add(s);
        added++;
      }
    }
    return added;
  },
  scard: async (key) => {
    const item = cleanExpired(key);
    if (!item || !(item.value instanceof Set)) return 0;
    return item.value.size;
  },
  smembers: async (key) => {
    const item = cleanExpired(key);
    if (!item || !(item.value instanceof Set)) return [];
    return Array.from(item.value);
  },
  hset: async (key, ...args) => {
    let item = cleanExpired(key);
    if (!item || !(item.value && typeof item.value === 'object' && !(item.value instanceof Set))) {
      item = { value: {}, expireAt: item ? item.expireAt : null };
      memStore.set(key, item);
    }
    let count = 0;
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      for (const [k, v] of Object.entries(args[0])) {
        if (!(k in item.value)) count++;
        item.value[k] = String(v);
      }
    } else {
      for (let i = 0; i < args.length; i += 2) {
        const k = String(args[i]);
        const v = String(args[i + 1] !== undefined ? args[i + 1] : '');
        if (!(k in item.value)) count++;
        item.value[k] = v;
      }
    }
    return count;
  },
  hget: async (key, field) => {
    const item = cleanExpired(key);
    if (!item || !item.value || typeof item.value !== 'object' || item.value instanceof Set) return null;
    return field in item.value ? String(item.value[field]) : null;
  },
  hgetall: async (key) => {
    const item = cleanExpired(key);
    if (!item || !item.value || typeof item.value !== 'object' || item.value instanceof Set) return {};
    const res = {};
    for (const [k, v] of Object.entries(item.value)) {
      res[k] = String(v);
    }
    return res;
  },
  hmset: async (key, ...args) => {
    await fallbackRedis.hset(key, ...args);
    return 'OK';
  },
  flushdb: async () => {
    memStore.clear();
    streamStore.clear();
    return 'OK';
  },
  pipeline: () => {
    const queue = [];
    const pipe = {
      get: (key) => {
        queue.push(async () => [null, await fallbackRedis.get(key)]);
        return pipe;
      },
      set: (key, value, mode, duration) => {
        queue.push(async () => [null, await fallbackRedis.set(key, value, mode, duration)]);
        return pipe;
      },
      ttl: (key) => {
        queue.push(async () => [null, await fallbackRedis.ttl(key)]);
        return pipe;
      },
      del: (...keys) => {
        queue.push(async () => [null, await fallbackRedis.del(...keys)]);
        return pipe;
      },
      exec: async () => {
        const results = [];
        for (const fn of queue) {
          try {
            results.push(await fn());
          } catch (err) {
            results.push([err, null]);
          }
        }
        return results;
      }
    };
    return pipe;
  },
  xadd: async (key, ...args) => {
    let fieldsStart = 0;
    let maxLen = 1000;
    let i = 0;
    while (i < args.length) {
      if (String(args[i]).toUpperCase() === 'MAXLEN') {
        if (args[i + 1] === '~' || args[i + 1] === '=') {
          maxLen = Number(args[i + 2]) || 1000;
          i += 3;
        } else {
          maxLen = Number(args[i + 1]) || 1000;
          i += 2;
        }
      } else if (args[i] === '*') {
        fieldsStart = i + 1;
        break;
      } else {
        fieldsStart = i;
        break;
      }
    }

    const fieldPairs = args.slice(fieldsStart);
    const flatFields = [];
    for (let f = 0; f < fieldPairs.length; f += 2) {
      flatFields.push(String(fieldPairs[f]), String(fieldPairs[f + 1] !== undefined ? fieldPairs[f + 1] : ''));
    }

    const id = `${Date.now()}-${streamSeq++}`;
    if (!streamStore.has(key)) {
      streamStore.set(key, []);
    }
    const stream = streamStore.get(key);
    stream.push({ id, fields: flatFields });
    if (stream.length > maxLen) {
      stream.splice(0, stream.length - maxLen);
    }

    const waiters = streamWaiters.get(key) || [];
    if (waiters.length > 0) {
      const remainingWaiters = [];
      for (const w of waiters) {
        if (id > w.minId) {
          clearTimeout(w.timer);
          w.resolve([[key, [[id, flatFields]]]]);
        } else {
          remainingWaiters.push(w);
        }
      }
      streamWaiters.set(key, remainingWaiters);
    }

    return id;
  },
  xrevrange: async (key, end, start, ...opts) => {
    const stream = streamStore.get(key) || [];
    let count = 50;
    for (let i = 0; i < opts.length; i++) {
      if (String(opts[i]).toUpperCase() === 'COUNT' && opts[i + 1] !== undefined) {
        count = Number(opts[i + 1]) || 50;
      }
    }
    const results = [];
    for (let i = stream.length - 1; i >= 0 && results.length < count; i--) {
      const item = stream[i];
      if (end !== '+' && item.id > end) continue;
      if (start !== '-' && item.id < start) continue;
      results.push([item.id, [...item.fields]]);
    }
    return results;
  },
  xrange: async (key, start, end, ...opts) => {
    const stream = streamStore.get(key) || [];
    let count = 1000;
    for (let i = 0; i < opts.length; i++) {
      if (String(opts[i]).toUpperCase() === 'COUNT' && opts[i + 1] !== undefined) {
        count = Number(opts[i + 1]) || 1000;
      }
    }
    const results = [];
    for (let i = 0; i < stream.length && results.length < count; i++) {
      const item = stream[i];
      if (start !== '-' && item.id < start) continue;
      if (end !== '+' && item.id > end) continue;
      results.push([item.id, [...item.fields]]);
    }
    return results;
  },
  xread: async (...args) => {
    let blockMs = 0;
    let streamsIdx = -1;
    for (let i = 0; i < args.length; i++) {
      if (String(args[i]).toUpperCase() === 'BLOCK') {
        blockMs = Number(args[i + 1]) || 0;
      }
      if (String(args[i]).toUpperCase() === 'STREAMS') {
        streamsIdx = i + 1;
      }
    }
    if (streamsIdx === -1) return null;
    const streamKey = args[streamsIdx];
    let startId = args[streamsIdx + 1] || '$';

    const stream = streamStore.get(streamKey) || [];
    if (startId === '$') {
      startId = stream.length > 0 ? stream[stream.length - 1].id : '0-0';
    }

    const matching = [];
    for (const item of stream) {
      if (item.id > startId) {
        matching.push([item.id, [...item.fields]]);
      }
    }

    if (matching.length > 0) {
      return [[streamKey, matching]];
    }

    if (blockMs <= 0) {
      return null;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = streamWaiters.get(streamKey) || [];
        streamWaiters.set(streamKey, list.filter(w => w.resolve !== resolve));
        resolve(null);
      }, blockMs);

      if (!streamWaiters.has(streamKey)) {
        streamWaiters.set(streamKey, []);
      }
      streamWaiters.get(streamKey).push({ resolve, minId: startId, timer });
    });
  },
  duplicate: () => {
    activeClientsCount++;
    const dup = {
      ...fallbackRedis,
      disconnect: () => {
        if (activeClientsCount > 1) activeClientsCount--;
        return 'OK';
      },
      quit: async () => {
        if (activeClientsCount > 1) activeClientsCount--;
        return 'OK';
      }
    };
    return dup;
  },
  disconnect: () => {
    if (activeClientsCount > 1) activeClientsCount--;
    return 'OK';
  },
  client: async (subcommand) => {
    if (String(subcommand).toUpperCase() === 'LIST') {
      let res = '';
      for (let c = 1; c <= activeClientsCount; c++) {
        res += `id=${c} addr=127.0.0.1:${50000 + c} fd=${c + 5} name= age=10 idle=0 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 obl=0 oll=0 omem=0 events=r cmd=client\n`;
      }
      return res;
    }
    return 'OK';
  },
  quit: async () => 'OK'
};

let useFallback = false;
const isStrictDb = process.env.STRICT_DB === 'true';

const retryStrategy = (times) => {
  if (isStrictDb) {
    if (times > 3) {
      console.error('[Redis Lỗi] Không thể kết nối tới máy chủ Redis (STRICT_DB=true). Đang dừng tiến trình.');
      process.exit(1);
    }
    return Math.min(times * 500, 3000);
  }
  if (times > 3) {
    if (!useFallback) {
      console.warn('[Redis] Không tìm thấy máy chủ Redis -> Tự động kích hoạt In-Memory Redis Engine (có TTL thực) để chạy Demo.');
      useFallback = true;
    }
    return null; // Ngừng retry kết nối TCP
  }
  return Math.min(times * 500, 3000);
};

const commonOptions = {
  connectTimeout: 10000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy
};

let realRedis;
if (process.env.REDIS_URL) {
  realRedis = new Redis(process.env.REDIS_URL, commonOptions);
} else {
  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    ...commonOptions
  };
  if (process.env.REDIS_PASSWORD) {
    redisConfig.password = process.env.REDIS_PASSWORD;
  }
  if (process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === true) {
    redisConfig.tls = {};
  }
  realRedis = new Redis(redisConfig);
}

realRedis.on('connect', () => {
  useFallback = false;
  console.log('[Redis] Đã kết nối thành công tới Redis Server.');
});

realRedis.on('error', (err) => {
  if (isStrictDb && !useFallback) {
    const safeMsg = err && err.message ? err.message.replace(/:[^@]+@/, ':***@') : 'Lỗi kết nối Redis';
    console.error(`[Redis Lỗi kết nối]: ${safeMsg}`);
  }
});

// Proxy tự động chuyển tiếp lệnh sang Redis thật hoặc Fallback Redis khi chưa bật Docker
const redisProxy = new Proxy(realRedis, {
  get(target, prop) {
    if (prop === 'isUsingFallback') {
      return () => (isStrictDb ? false : useFallback);
    }
    if (prop === 'pipeline') {
      return (...args) => {
        if (useFallback && 'pipeline' in fallbackRedis) {
          return fallbackRedis.pipeline(...args);
        }
        return target.pipeline(...args);
      };
    }
    if (useFallback && prop in fallbackRedis) {
      if (isStrictDb) {
        console.error('[Redis Lỗi] Hệ thống cấu hình STRICT_DB=true, không cho phép sử dụng bộ giả lập.');
        process.exit(1);
      }
      return fallbackRedis[prop];
    }
    const orig = target[prop];
    if (typeof orig === 'function') {
      return async (...args) => {
        if (useFallback && prop in fallbackRedis) {
          if (isStrictDb) {
            console.error('[Redis Lỗi] Hệ thống cấu hình STRICT_DB=true, không cho phép sử dụng bộ giả lập.');
            process.exit(1);
          }
          return fallbackRedis[prop](...args);
        }
        try {
          return await orig.apply(target, args);
        } catch (err) {
          if (!isStrictDb && prop in fallbackRedis) {
            useFallback = true;
            return fallbackRedis[prop](...args);
          }
          throw err;
        }
      };
    }
    return orig;
  }
});

module.exports = redisProxy;
