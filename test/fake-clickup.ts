export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | FormData | null;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response> | undefined;

/** A fetch stand-in for api.clickup.com that records every request. */
export function fakeClickUp(handler: Handler = () => undefined) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const body = init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? init.body : null;
    const req: RecordedRequest = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    requests.push(req);
    const custom = await handler(req);
    if (custom) return custom;
    if (url.pathname === '/api/v2/team') {
      return Response.json({
        teams: [
          {
            id: '9001',
            name: 'Acme',
            members: [
              { user: { id: 1, username: 'Ada Lovelace', email: 'ada@acme.test', initials: 'AL', role: 1 } },
              { user: { id: 2, username: 'Grace Hopper', email: 'grace@acme.test', initials: 'GH', role: 3 } },
            ],
          },
        ],
      });
    }
    return Response.json({ ok: true, path: url.pathname });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}
