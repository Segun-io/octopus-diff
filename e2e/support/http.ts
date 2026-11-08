import { request } from 'node:http';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Plain `node:http` request with full control over `Host`, `Origin` and `Cookie` (fetch
 * implementations restrict some of these). Reads at most `maxBytes` of the body; with `stream`,
 * a 200 response resolves right after the headers (SSE streams never end).
 */
export function rawRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    stream?: boolean;
    maxBytes?: number;
  } = {},
): Promise<RawResponse> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: {
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        setHost: !Object.keys(options.headers ?? {}).some((h) => h.toLowerCase() === 'host'),
      },
      (res) => {
        if (options.stream && res.statusCode === 200) {
          // An open event stream never ends: headers are all we need.
          res.destroy();
          resolve({ status: 200, headers: res.headers, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= (options.maxBytes ?? 4 * 1024 * 1024)) {
            res.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', () => done());
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Extracts `name=value` pairs from `Set-Cookie` headers. */
export function cookiesFrom(
  headers: RawResponse['headers'],
): Map<string, { value: string; raw: string }> {
  const set = headers['set-cookie'];
  const list = Array.isArray(set) ? set : set ? [set] : [];
  const cookies = new Map<string, { value: string; raw: string }>();
  for (const raw of list) {
    const [pair = ''] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), { value: pair.slice(eq + 1).trim(), raw });
  }
  return cookies;
}
