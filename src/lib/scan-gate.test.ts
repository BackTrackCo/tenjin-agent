import { describe, it, expect } from 'vitest';
import {
  mergeScanFindings,
  parseScanRejection,
  parseScanSuccessReport,
  scanNoteLines,
  scanReceipt,
  SCAN_BLOCKED,
  SCAN_NEEDS_ACK,
} from './scan-gate';
import type { ScanFinding } from './scan';

function envelope(code: string, scan: unknown): unknown {
  return { error: { code, message: 'held', details: { scan } } };
}

describe('parseScanRejection', () => {
  it('reads a needs_ack envelope with its findings, token and semantic marker', () => {
    const parsed = parseScanRejection(
      422,
      envelope(SCAN_NEEDS_ACK, {
        findings: [
          {
            check: 'email',
            severity: 'warn',
            line: 3,
            span: [4, 20],
            excerpt: 'a@b.co',
            field: 'body',
          },
        ],
        checks: { semantic: 'ran' },
        ackToken: 'v1.p.mac',
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('needs-ack');
    expect(parsed?.report.ackToken).toBe('v1.p.mac');
    expect(parsed?.report.semantic).toBe('ran');
    expect(parsed?.report.findings).toHaveLength(1);
    expect(parsed?.report.findings[0]?.field).toBe('body');
  });

  it('never carries an ack token off a blocked envelope, even if one is sent', () => {
    const parsed = parseScanRejection(
      422,
      envelope(SCAN_BLOCKED, { findings: [], ackToken: 'should-be-dropped' }),
    );
    expect(parsed?.kind).toBe('blocked');
    expect(parsed?.report.ackToken).toBeUndefined();
  });

  it('is null for another 422 code and for a gate code at another status', () => {
    expect(parseScanRejection(422, envelope('validation_failed', {}))).toBeNull();
    expect(parseScanRejection(500, envelope(SCAN_BLOCKED, {}))).toBeNull();
    expect(parseScanRejection(422, { nope: true })).toBeNull();
  });

  it('still reports a rejection when details.scan is unreadable', () => {
    const parsed = parseScanRejection(422, { error: { code: SCAN_BLOCKED, message: 'no' } });
    expect(parsed?.kind).toBe('blocked');
    expect(parsed?.report.findings).toEqual([]);
  });

  it('keeps a detector and a tier this release has never heard of', () => {
    const parsed = parseScanRejection(
      422,
      envelope(SCAN_NEEDS_ACK, {
        findings: [
          { check: 'quantum-seed-phrase', severity: 'notice', line: 9, excerpt: 'zzz…', extra: 1 },
        ],
        checks: { semantic: 'skipped', future: 'ran' },
        ackToken: 't',
      }),
    );
    expect(parsed?.report.findings[0]).toMatchObject({
      check: 'quantum-seed-phrase',
      severity: 'notice',
      line: 9,
    });
    expect(parsed?.report.semantic).toBe('skipped');
  });

  it('drops only the malformed findings, keeping the readable ones', () => {
    const parsed = parseScanRejection(
      422,
      envelope(SCAN_NEEDS_ACK, {
        findings: [
          { check: 'email' },
          null,
          { check: 'phone', severity: 'warn', line: 1, excerpt: 'x' },
        ],
        ackToken: 't',
      }),
    );
    expect(parsed?.report.findings.map((f) => f.check)).toEqual(['phone']);
  });
});

describe('parseScanSuccessReport', () => {
  it('reads the advisory report riding a success response', () => {
    const report = parseScanSuccessReport({
      id: 'p1',
      scan: { findings: [{ check: 'email', severity: 'warn', line: 2, excerpt: 'a@b.co' }] },
    });
    expect(report?.findings).toHaveLength(1);
  });

  it('is null for a server that sent none, and for an empty report', () => {
    expect(parseScanSuccessReport({ id: 'p1' })).toBeNull();
    expect(parseScanSuccessReport({ id: 'p1', scan: null })).toBeNull();
    expect(parseScanSuccessReport({ id: 'p1', scan: { findings: [] } })).toBeNull();
  });

  it('survives a semantic-only report so the marker still reaches the caller', () => {
    const report = parseScanSuccessReport({
      scan: { findings: [], checks: { semantic: 'skipped' } },
    });
    expect(report?.semantic).toBe('skipped');
  });
});

const local = (over: Partial<ScanFinding> = {}): ScanFinding => ({
  check: 'email',
  severity: 'warn',
  line: 7,
  span: [0, 6],
  excerpt: 'a@b.co',
  ...over,
});

describe('mergeScanFindings', () => {
  it('collapses one value both scans found and marks it as both', () => {
    const merged = mergeScanFindings(
      [local()],
      [{ check: 'email', severity: 'warn', line: 7, span: [0, 6], excerpt: 'a@b.co' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('both');
  });

  it('collapses the same detector + excerpt even when the offsets differ', () => {
    // The local scan reads the whole file (frontmatter included); the gate scans
    // the extracted body, so the identical secret lands on different lines.
    const merged = mergeScanFindings(
      [local({ line: 12 })],
      [{ check: 'email', severity: 'warn', line: 3, span: [4, 10], excerpt: 'a@b.co' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ line: 12, source: 'both' });
  });

  // The offset key is a LOCAL-side key. Reading it in the server loop collapsed a
  // distinct server finding into a local one whose coordinates merely coincided
  // (routine on a draft with no frontmatter, where body and raw lines agree), and
  // the operator then acked a set the render had dropped a member of.
  it('keeps a server finding that only shares coordinates with a local one', () => {
    const merged = mergeScanFindings(
      [local()],
      [{ check: 'email', severity: 'warn', line: 7, span: [0, 6], excerpt: 'other@b.co' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ excerpt: 'a@b.co', source: 'local' });
    expect(merged[1]).toMatchObject({ excerpt: 'other@b.co', source: 'server' });
  });

  it('keeps a server-only finding, tagged server, with its field', () => {
    const merged = mergeScanFindings(
      [local()],
      [{ check: 'semantic-pii', severity: 'warn', line: 1, excerpt: 'reads as…', field: 'body' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ check: 'semantic-pii', source: 'server', field: 'body' });
  });

  it('renders local findings first and never duplicates within one side', () => {
    const merged = mergeScanFindings([local(), local()], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('local');
  });

  // Server offsets are per-field, so two one-line fields collide on line 1 as a
  // matter of course. Collapsing them would leave the operator acking a secret
  // the server flagged and the render never showed.
  it('keeps two server findings that share an offset in different fields', () => {
    const merged = mergeScanFindings(
      [],
      [
        {
          check: 'email',
          severity: 'warn',
          line: 1,
          span: [8, 22],
          excerpt: 'x@b.co',
          field: 'title',
        },
        {
          check: 'email',
          severity: 'warn',
          line: 1,
          span: [8, 22],
          excerpt: 'y@b.co',
          field: 'excerpt',
        },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((f) => f.field)).toEqual(['title', 'excerpt']);
  });

  // The same secret in two fields is still one finding: the value key collapses
  // it even though nothing else about the two entries matches.
  it('still collapses one secret repeated across two fields', () => {
    const merged = mergeScanFindings(
      [],
      [
        {
          check: 'email',
          severity: 'warn',
          line: 1,
          span: [8, 22],
          excerpt: 'x@b.co',
          field: 'title',
        },
        {
          check: 'email',
          severity: 'warn',
          line: 9,
          span: [0, 6],
          excerpt: 'x@b.co',
          field: 'body',
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ field: 'title', source: 'server' });
  });
});

describe('scanReceipt / scanNoteLines', () => {
  it('projects a report to machine data with the semantic marker and ack flag', () => {
    const receipt = scanReceipt({
      findings: [{ check: 'email', severity: 'warn', line: 2, excerpt: 'a@b.co' }],
      semantic: 'ran',
      acked: true,
    });
    expect(receipt).toMatchObject({ semantic: 'ran', acked: true });
    expect(receipt.findings[0]).toMatchObject({ check: 'email', source: 'server' });
  });

  it('renders unknown detectors faithfully and strips escapes out of them', () => {
    const lines = scanNoteLines({
      findings: [
        { check: 'quantum\u001b[31m-seed', severity: 'notice', line: 4, excerpt: 'zz\u001b[0mz' },
      ],
    });
    expect(lines[0]).toContain('advisory');
    expect(lines[1]).toBe('  quantum-seed (notice, line 4): zzz');
  });

  it('says so when the findings were acknowledged, and says nothing with none', () => {
    expect(
      scanNoteLines({
        findings: [{ check: 'email', severity: 'warn', line: 1, excerpt: 'a' }],
        acked: true,
      })[0],
    ).toContain('Acknowledged');
    expect(scanNoteLines({ findings: [] })).toEqual([]);
    expect(scanNoteLines(undefined)).toEqual([]);
  });
});
