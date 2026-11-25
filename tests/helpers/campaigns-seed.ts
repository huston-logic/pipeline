// Stand-ins for the demo seed's campaigns (scripts/seed-dev.ts, decision 0053) on a fixture-seeded database, so a unit
// test can open every path in boardRoutes: a draft to Partners, a sent campaign with a bounce, a draft to people picked.
import type { SqliteD1 } from "../../src/db/sqlite-d1.ts";

export function addStandInCampaigns(db: SqliteD1): void {
  db.exec(`UPDATE settings SET campaigns = 1;
    INSERT OR IGNORE INTO contacts (id, name, email, person_status, sub_status) VALUES
      ('ct_seed08', 'Ruth Adams', 'ruth.adams@example.org', 'contact', NULL),
      ('ct_seed07', 'Luis Ortega', 'luis@example.com', 'contact', NULL);
    INSERT INTO campaigns (id, name, status, audience, approved_at, completed_at) VALUES
      ('cp_seed01', 'Spring open house', 'draft', '{"kind":"status","status":"partner"}', NULL, NULL),
      ('cp_seed02', 'November newsletter', 'sent', '{"kind":"people","people":["ct_seed07","ct_seed08"]}', '2026-11-17T18:00:00.000Z', '2026-11-18T18:00:00.000Z'),
      ('cp_seed03', 'Thank you to referrers', 'draft', '{"kind":"people","people":["ct_seed07"]}', NULL, NULL);
    INSERT INTO campaign_steps (id, campaign_id, position, subject, body) VALUES
      ('cs_seed01', 'cp_seed01', 1, 'You are invited', 'Hi.'),
      ('cs_seed02', 'cp_seed02', 1, 'November news', 'Hi.'),
      ('cs_seed03', 'cp_seed03', 1, 'Thank you', 'Hi.');
    INSERT INTO campaign_recipients (id, campaign_id, step_id, contact_id, email, status, unsub_token, sent_at, bounced_at, delivered_at, unsubscribed_at) VALUES
      ('rc_seed01', 'cp_seed02', 'cs_seed02', 'ct_seed07', 'luis@example.com', 'bounced', 'tokseed01', '2026-11-17T18:30:00.000Z', '2026-11-17T18:32:00.000Z', NULL, NULL),
      ('rc_seed02', 'cp_seed02', 'cs_seed02', 'ct_seed08', 'ruth.adams@example.org', 'delivered', 'tokseed02', '2026-11-17T18:30:00.000Z', NULL, '2026-11-17T18:31:00.000Z', '2026-11-19T17:00:00.000Z');
    INSERT INTO email_suppressions (id, email, reason, contact_id, campaign_id) VALUES
      ('su_seed01', 'luis@example.com', 'bounced', 'ct_seed07', 'cp_seed02'),
      ('su_seed02', 'ruth.adams@example.org', 'unsubscribed', 'ct_seed08', 'cp_seed02')`);
}
