// Runs one accounting day with Claude: the orchestrator delegates to the six
// agents, then prints what they did and what is waiting for a person.
import { Books } from "./db.ts";
import { runAgent } from "./harness.ts";
import { claude } from "./model.ts";

const books = await Books.open();
const today = "2026-10-15";

console.log(`Ferretería El Tornillo · ${today} · running the orchestrator…\n`);
const result = await runAgent("orchestrator", "Run today's accounting.", { books, model: claude(), today, maxTurns: 25 });
console.log(result.summary, "\n");

const show = async (title: string, sql: string) => {
  const rows = await books.asOwner((q) => q(sql));
  console.log(`── ${title} (${rows.length})`);
  if (rows.length) console.table(rows);
};

await show(
  "Tool calls per agent",
  `select agent, count(*)::int as calls, count(*) filter (where not ok)::int as rejected
     from agent_actions group by agent order by agent`,
);
await show("Supplier invoices recorded", "select number, total::float8, due_on::text from supplier_invoices where document_id is not null");
await show("Customer invoices issued", "select number, total::float8, due_on::text from customer_invoices where issued_on = '2026-10-15'");
await show("Bank lines matched", "select bank_line_id, customer_invoice_id, supplier_invoice_id from reconciliations");
await show("Payments waiting for approval", "select supplier_invoice_id, pay_on::text, amount::float8 from payment_proposals");
await show("Reminders waiting to be sent", "select customer_invoice_id, left(body, 80) as body from reminder_drafts");
await show("Escalated to a person", "select agent, subject, left(reason, 100) as reason from escalations");

await books.close();
