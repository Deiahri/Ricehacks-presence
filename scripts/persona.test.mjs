import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INQUIRY_ID, inquiryVerdict } from '../persona.mjs';

const UID = '4f8a1c2e-0b9d-4e7a-9c3f-1a2b3c4d5e6f';
const inquiry = (status, referenceId = UID) => ({ data: { id: 'inq_abc123', attributes: { status, 'reference-id': referenceId } } });

test('completed and approved inquiries for this account pass', () => {
  assert.deepEqual(inquiryVerdict(inquiry('completed'), UID), { ok: true, status: 'completed' });
  assert.deepEqual(inquiryVerdict(inquiry('approved'), UID), { ok: true, status: 'approved' });
});

test('an inquiry that has not passed is refused', () => {
  for (const status of ['created', 'pending', 'declined', 'failed', 'expired', 'needs_review']) {
    assert.deepEqual(inquiryVerdict(inquiry(status), UID), { ok: false, reason: 'not-passed', status });
  }
});

test("someone else's inquiry is refused, even when it passed", () => {
  assert.equal(inquiryVerdict(inquiry('approved', 'another-user'), UID).reason, 'not-yours');
  assert.equal(inquiryVerdict(inquiry('approved', null), UID).reason, 'not-yours');
  assert.equal(inquiryVerdict(inquiry('approved'), null).reason, 'not-yours');
});

test('a malformed inquiry is refused', () => {
  assert.equal(inquiryVerdict(null, UID).reason, 'bad-inquiry');
  assert.equal(inquiryVerdict({ data: {} }, UID).reason, 'bad-inquiry');
  assert.equal(inquiryVerdict({ data: { attributes: { 'reference-id': UID } } }, UID).reason, 'bad-inquiry');
});

test('inquiry id format', () => {
  assert.ok(INQUIRY_ID.test('inq_2Bx8Kq9tZ4mYw1Lr'));
  assert.ok(!INQUIRY_ID.test('inq_'));
  assert.ok(!INQUIRY_ID.test('../../accounts'));
  assert.ok(!INQUIRY_ID.test('inq_abc/../x'));
});
