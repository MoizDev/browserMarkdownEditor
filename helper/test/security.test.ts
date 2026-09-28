import { describe, expect, test } from 'bun:test';
import { PRODUCTION_ORIGIN, isUuid } from '../../shared/vaultAgentProtocol.ts';
import { BAKED_ORIGINS } from '../src/buildInfo.ts';
import { BadRequest, isInside, vaultDir } from '../src/paths.ts';
import { bearerMatches, isAllowedHost, isAllowedOrigin, looksLikeToken, makeOriginPolicy, newRunToken, normalizeOrigin } from '../src/security.ts';

describe('origins', () => {
    const prod = makeOriginPolicy(BAKED_ORIGINS, false);
    const dev = makeOriginPolicy(BAKED_ORIGINS, true);

    test('the production origin is always baked in', () => {
        expect(BAKED_ORIGINS).toContain(PRODUCTION_ORIGIN);
        expect(isAllowedOrigin('https://notes.moizhashmi.com', prod)).toBe(true);
    });

    test('exact match only', () => {
        for (const bad of [
            'https://notes.moizhashmi.com.evil.com', 'https://evil.notes.moizhashmi.com', 'http://notes.moizhashmi.com',
            'https://notes.moizhashmi.com:8443', 'https://notes.moizhashmi.com/', 'https://notes.moizhashmi.com/path',
            'null', '', 'file://', 'chrome-extension://abc', 'https://user@notes.moizhashmi.com',
        ]) expect(isAllowedOrigin(bad, prod)).toBe(false);
        expect(isAllowedOrigin(null, prod)).toBe(false);
        expect(isAllowedOrigin(undefined, prod)).toBe(false);
    });

    test('case-insensitive host, default port folded', () => {
        expect(isAllowedOrigin('https://NOTES.moizhashmi.com', prod)).toBe(true);
        expect(isAllowedOrigin('https://notes.moizhashmi.com:443', prod)).toBe(true);
    });

    test('dev origins only with --dev', () => {
        for (const o of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost']) {
            expect(isAllowedOrigin(o, prod)).toBe(false);
            expect(isAllowedOrigin(o, dev)).toBe(true);
        }
        for (const o of ['https://localhost:5173', 'http://localhost.evil.com:5173', 'http://127.0.0.2:5173', 'http://[::1]:5173']) {
            expect(isAllowedOrigin(o, dev)).toBe(false);
        }
    });

    test('normalizeOrigin rejects non-origins', () => {
        expect(normalizeOrigin('https://a.b/c')).toBeNull();
        expect(normalizeOrigin('https://a.b?x')).toBeNull();
        expect(normalizeOrigin('ftp://a.b')).toBeNull();
        expect(normalizeOrigin('https://A.b')).toBe('https://a.b');
    });
});

describe('host (DNS rebinding)', () => {
    test('only the loopback literal or localhost, with our port', () => {
        expect(isAllowedHost('127.0.0.1:47823', 47823)).toBe(true);
        expect(isAllowedHost('localhost:47823', 47823)).toBe(true);
        expect(isAllowedHost('LOCALHOST:47823', 47823)).toBe(true);
        for (const h of ['127.0.0.1', '127.0.0.1:47824', 'evil.com:47823', 'evil.com', '0.0.0.0:47823', '[::1]:47823', '', null]) {
            expect(isAllowedHost(h, 47823)).toBe(false);
        }
    });
});

describe('run tokens', () => {
    test('256 random bits, url-safe, unique', () => {
        const a = newRunToken();
        const b = newRunToken();
        expect(a).not.toBe(b);
        expect(looksLikeToken(a)).toBe(true);
        expect(Buffer.from(a, 'base64url').length).toBe(32);
    });

    test('bearer must equal the path token exactly', () => {
        const t = newRunToken();
        expect(bearerMatches(`Bearer ${t}`, t)).toBe(true);
        expect(bearerMatches(`bearer ${t}`, t)).toBe(true);
        expect(bearerMatches(`Bearer ${t}x`, t)).toBe(false);
        expect(bearerMatches(`Bearer ${newRunToken()}`, t)).toBe(false);
        expect(bearerMatches(t, t)).toBe(false);
        expect(bearerMatches(null, t)).toBe(false);
        expect(bearerMatches(`Basic ${t}`, t)).toBe(false);
    });

    test('token shape check', () => {
        expect(looksLikeToken('../../etc/passwd')).toBe(false);
        expect(looksLikeToken('a'.repeat(43))).toBe(true);
        expect(looksLikeToken('a'.repeat(44))).toBe(false);
    });
});

describe('vault ids and paths', () => {
    const root = '/tmp/sessions-root';
    test('vaultId must be a UUID', () => {
        expect(vaultDir(root, '6f1c2d3e-4a5b-4c6d-8e7f-001122334455')).toBe('/tmp/sessions-root/6f1c2d3e-4a5b-4c6d-8e7f-001122334455');
        for (const bad of ['..', '../x', 'x', '', '6f1c2d3e-4a5b-4c6d-8e7f-00112233445', '6f1c2d3e/4a5b-4c6d-8e7f-001122334455', null, 42, '/etc']) {
            expect(() => vaultDir(root, bad)).toThrow(BadRequest);
        }
    });

    test('ids are lower-cased so one vault is one folder', () => {
        expect(vaultDir(root, '6F1C2D3E-4A5B-4C6D-8E7F-001122334455')).toBe(vaultDir(root, '6f1c2d3e-4a5b-4c6d-8e7f-001122334455'));
    });

    test('isInside', () => {
        expect(isInside('/a/b', '/a/b/c')).toBe(true);
        expect(isInside('/a/b', '/a/b')).toBe(true);
        expect(isInside('/a/b', '/a/bc')).toBe(false);
        expect(isInside('/a/b', '/a/b/../c')).toBe(false);
        expect(isInside('/a/b', '/a/b/..x')).toBe(true);
    });

    test('isUuid (shared)', () => {
        expect(isUuid('01a0e5da-8462-7052-80fd-7f0d557d43d3')).toBe(true); // Codex threads are UUIDv7
        expect(isUuid('ses_abc')).toBe(false);
    });
});
