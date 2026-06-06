import { buildRequestLoggerOptions } from './request-logger.config';
import {
  REDACTED,
  REQUEST_ID_HEADER,
  type LoggableRequest,
} from './request-log.util';

/**
 * Unit tests for the structured request-logger configuration (task 9.1).
 *
 * These exercise the behaviour-bearing pieces of the pino-http options that
 * implement Requirements 12.1 (request id + route), 12.6 (uid when
 * authenticated), and 12.2 / 13.2 (no token/secret values in the stream).
 * pino-http is only a *type* dependency of the config module, so the options can
 * be built and invoked without booting Nest or pino.
 */
describe('buildRequestLoggerOptions', () => {
  it('emits exactly one completion log per request (autoLogging on)', () => {
    expect(buildRequestLoggerOptions().autoLogging).toBe(true);
  });

  describe('genReqId', () => {
    it('reuses an inbound x-request-id and echoes it back on the response', () => {
      const opts = buildRequestLoggerOptions();
      const headers: Record<string, unknown> = {};
      const res = {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      };
      const req = { headers: { [REQUEST_ID_HEADER]: 'inbound-id' } };

      const id = opts.genReqId!(req as never, res as never);

      expect(id).toBe('inbound-id');
      expect(headers[REQUEST_ID_HEADER]).toBe('inbound-id');
    });

    it('generates a fresh id when none is supplied', () => {
      const opts = buildRequestLoggerOptions();
      const res = { setHeader: () => undefined };
      const req = { headers: {} };

      const id = opts.genReqId!(req as never, res as never);

      expect(typeof id).toBe('string');
      expect(String(id).length).toBeGreaterThan(0);
    });
  });

  describe('customProps', () => {
    const customProps = (req: LoggableRequest) =>
      (buildRequestLoggerOptions().customProps as (r: unknown, s: unknown) => Record<string, unknown>)(
        req,
        {},
      );

    it('always includes the sanitised route', () => {
      const props = customProps({ url: '/api/devices/register' });
      expect(props.route).toBe('/api/devices/register');
      expect(props.uid).toBeUndefined();
    });

    it('includes the Firebase UID only when authenticated', () => {
      const props = customProps({
        url: '/api/devices/register',
        authContext: { uid: 'firebase-uid-123' },
      });
      expect(props.uid).toBe('firebase-uid-123');
    });

    it('redacts token/secret query parameter values in the route', () => {
      const props = customProps({ url: '/ws/connect?token=supersecret&foo=bar' });
      expect(props.route).toBe(`/ws/connect?token=${REDACTED}&foo=bar`);
      expect(JSON.stringify(props)).not.toContain('supersecret');
    });
  });

  describe('req serializer', () => {
    const serialize = (req: LoggableRequest) =>
      (buildRequestLoggerOptions().serializers!.req as (r: unknown) => Record<string, unknown>)(req);

    it('keeps id/method/route and drops all headers', () => {
      const serialized = serialize({
        id: 'req-1',
        method: 'POST',
        url: '/api/devices/register',
        headers: { authorization: 'Bearer leaked-token', cookie: 'session=leaked' },
      });

      expect(serialized).toEqual({
        id: 'req-1',
        method: 'POST',
        route: '/api/devices/register',
      });
      expect(JSON.stringify(serialized)).not.toContain('leaked-token');
      expect(JSON.stringify(serialized)).not.toContain('leaked');
    });
  });

  describe('redact', () => {
    it('censors known token/secret header paths', () => {
      const redact = buildRequestLoggerOptions().redact as {
        paths: string[];
        censor: string;
      };
      expect(redact.censor).toBe(REDACTED);
      expect(redact.paths).toEqual(
        expect.arrayContaining([
          'req.headers.authorization',
          'req.headers.cookie',
        ]),
      );
    });
  });
});
