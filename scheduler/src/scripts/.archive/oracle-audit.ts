import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../../.env') });
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

(async () => {
  const { data: all } = await sb.from('oracle_price_history').select('publish_reason, timestamp, team').order('timestamp', { ascending: true });
  if (!all) { console.log('No data'); return; }
  
  const byReason = new Map<string, number>();
  for (const r of all) {
    byReason.set(r.publish_reason, (byReason.get(r.publish_reason) ?? 0) + 1);
  }
  console.log('\nBy publish_reason:');
  for (const [reason, count] of byReason) {
    console.log('  ' + reason + ': ' + count);
  }
  
  const mrDates = new Map<string, number>();
  const mrRows = all.filter(r => r.publish_reason === 'market_refresh' || r.publish_reason === 'live_update');
  for (const r of mrRows) {
    const d = r.timestamp.slice(0, 10);
    mrDates.set(d, (mrDates.get(d) ?? 0) + 1);
  }
  console.log('\nmarket_refresh/live_update date distribution:');
  for (const [date, count] of [...mrDates.entries()].sort()) {
    console.log('  ' + date + ': ' + count + ' rows');
  }
  
  const settlementDates = new Map<string, number>();
  const sRows = all.filter(r => r.publish_reason === 'settlement');
  for (const r of sRows) {
    const d = r.timestamp.slice(0, 10);
    settlementDates.set(d, (settlementDates.get(d) ?? 0) + 1);
  }
  console.log('\nsettlement timestamp distribution:');
  for (const [date, count] of [...settlementDates.entries()].sort()) {
    console.log('  ' + date + ': ' + count + ' rows');
  }

  const team = 'Bayern München';
  const teamRows = all.filter(r => r.team === team);
  console.log('\n' + team + ' rows: ' + teamRows.length);
  for (const r of teamRows) {
    console.log('  ' + r.timestamp.slice(0, 19) + ' [' + r.publish_reason + ']');
  }
  
  console.log('\nTotal rows: ' + all.length);
})();
