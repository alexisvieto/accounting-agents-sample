import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Books } from "../src/db.ts";
import { runAgent } from "../src/harness.ts";
import { scripted, type Turn } from "./scripted.ts";

const TODAY = "2026-10-15";
let books: Books;

beforeEach(async () => {
  books = await Books.open();
});
afterEach(() => books.close());

const owner = (sql: string, params?: unknown[]) => books.asOwner((q) => q(sql, params));
const run = (agent: Parameters<typeof runAgent>[0], script: Partial<Record<string, Turn[]>>, maxTurns?: number) => {
  const s = scripted(script);
  return { ...s, result: runAgent(agent, "Do today's work.", { books, model: s.model, today: TODAY, maxTurns }) };
};

const invoice = {
  document_id: 1,
  supplier_tax_id: "155-1234-56",
  number: "FAC-0981",
  issued_on: "2026-10-01",
  due_on: "2026-10-31",
  subtotal: 2400,
  tax: 168,
  total: 2568,
};

describe("intake", () => {
  test("records an invoice that checks out", async () => {
    const { result, resultsFor } = run("intake", {
      intake: [[{ tool: "record_supplier_invoice", input: invoice }], { text: "Recorded FAC-0981." }],
    });
    assert.equal((await result).outcome, "done");
    assert.equal(resultsFor("intake")[0].error, false);
    const [row] = await owner("select total::float8, status from supplier_invoices where number = 'FAC-0981'");
    assert.deepEqual(row, { total: 2568, status: "open" });
  });

  test("the code checks the arithmetic, not the model", async () => {
    const { result, resultsFor } = run("intake", {
      intake: [
        [{ tool: "record_supplier_invoice", input: { ...invoice, document_id: 2, supplier_tax_id: "155-7788-01", number: "P-91", subtotal: 850, tax: 59.5, total: 919.5 } }],
        [{ tool: "escalate", input: { subject: "Invoice P-91 from Pinturas Bahía", reason: "Total is 919.50 but 850.00 + 59.50 = 909.50." } }],
        { text: "Escalated P-91." },
      ],
    });
    await result;
    assert.match(resultsFor("intake")[0].text, /= 909.5, not 919.5/);
    assert.equal((await owner("select count(*)::int as n from supplier_invoices where number = 'P-91'"))[0].n, 0);
    assert.equal((await owner("select agent from escalations"))[0].agent, "agent_intake");
  });

  test("rejects a duplicate and an unknown supplier", async () => {
    const { result, resultsFor } = run("intake", {
      intake: [
        [
          { tool: "record_supplier_invoice", input: { ...invoice, document_id: 3, supplier_tax_id: "155-4410-22", number: "F-2210", subtotal: 400, tax: 28, total: 428 } },
          { tool: "record_supplier_invoice", input: { ...invoice, document_id: 4, supplier_tax_id: "8-999-1234", number: "0001", subtotal: 9158.88, tax: 641.12, total: 9800 } },
        ],
        { text: "Done." },
      ],
    });
    await result;
    const [dup, unknown] = resultsFor("intake");
    assert.match(dup.text, /already on the books/);
    assert.match(unknown.text, /Unknown supplier/);
  });

  test("can't reach a tool it wasn't given, whatever a document says", async () => {
    // Document 4 asks the AI to schedule a payment. Suppose the model obeys.
    const { result, requests, resultsFor } = run("intake", {
      intake: [[{ tool: "propose_payment", input: { supplier_invoice_id: 1, pay_on: TODAY } }], { text: "Done." }],
    });
    await result;
    assert.ok(!requests[0].tools.some((t) => t.name === "propose_payment"), "not offered to the model");
    assert.match(resultsFor("intake")[0].text, /not available to the intake agent/);
    assert.equal((await owner("select count(*)::int as n from payment_proposals"))[0].n, 0);
  });
});

describe("payables", () => {
  test("proposes payments that a person still has to approve", async () => {
    const { result } = run("payables", {
      payables: [
        [{ tool: "list_payables", input: { due_within_days: 10 } }],
        [
          { tool: "propose_payment", input: { supplier_invoice_id: 2, pay_on: TODAY } }, // P-77, overdue
          { tool: "propose_payment", input: { supplier_invoice_id: 1, pay_on: "2026-10-18" } }, // F-2210
        ],
        { text: "Two payments proposed." },
      ],
    });
    await result;
    const rows = await owner("select supplier_invoice_id, amount::float8, status from payment_proposals order by supplier_invoice_id");
    assert.deepEqual(rows, [
      { supplier_invoice_id: 1, amount: 428, status: "proposed" },
      { supplier_invoice_id: 2, amount: 535, status: "proposed" },
    ]);
  });

  test("the amount comes from the invoice and the date is checked", async () => {
    const { result, resultsFor } = run("payables", {
      payables: [[{ tool: "propose_payment", input: { supplier_invoice_id: 1, pay_on: "2026-11-30" } }], { text: "x" }],
    });
    await result;
    assert.match(resultsFor("payables")[0].text, /between 2026-10-15 and 2026-10-18/);
  });

  test("can't approve its own proposal, even with raw SQL", async () => {
    await books.asAgent("agent_payables", (q) =>
      q("insert into payment_proposals (supplier_invoice_id, pay_on, amount) values (1, '2026-10-18', 428)"),
    );
    await assert.rejects(
      books.asAgent("agent_payables", (q) => q("update payment_proposals set status = 'approved'")),
      /permission denied/,
    );
    await assert.rejects(
      books.asAgent("agent_payables", (q) =>
        q("insert into payment_proposals (supplier_invoice_id, pay_on, amount, status) values (2, '2026-10-15', 535, 'approved')"),
      ),
      /permission denied/,
    );
  });
});

describe("billing", () => {
  test("number, ITBMS, total and due date are computed in code", async () => {
    const { result, resultsFor } = run("billing", {
      billing: [[{ tool: "issue_invoice", input: { order_id: 501 } }], { text: "Issued." }],
    });
    await result;
    assert.deepEqual(JSON.parse(resultsFor("billing")[0].text), { number: "FV-1004", subtotal: 3200, tax: 224, total: 3424 });
    const [row] = await owner("select due_on::text from customer_invoices where number = 'FV-1004'");
    assert.equal(row.due_on, "2026-11-14");
  });

  test("won't invoice an order twice", async () => {
    const { result, resultsFor } = run("billing", {
      billing: [[{ tool: "issue_invoice", input: { order_id: 501 } }], [{ tool: "issue_invoice", input: { order_id: 501 } }], { text: "x" }],
    });
    await result;
    assert.match(resultsFor("billing")[1].text, /already invoiced/);
  });
});

describe("reconciliation", () => {
  test("matches exact amounts and marks the invoice paid", async () => {
    const { result } = run("reconciliation", {
      reconciliation: [
        [{ tool: "match_candidates", input: { bank_line_id: 1 } }],
        [{ tool: "record_match", input: { bank_line_id: 1, customer_invoice_id: 2 } }],
        { text: "Matched." },
      ],
    });
    await result;
    assert.equal((await owner("select paid from customer_invoices where number = 'FV-1002'"))[0].paid, true);
  });

  test("refuses a partial payment", async () => {
    // Bank line 4 is 1,000.00 from Las Lajas; their invoice FV-1001 is 1,070.00.
    const { result, resultsFor } = run("reconciliation", {
      reconciliation: [
        [{ tool: "match_candidates", input: { bank_line_id: 4 } }],
        [{ tool: "record_match", input: { bank_line_id: 4, customer_invoice_id: 1 } }],
        { text: "x" },
      ],
    });
    await result;
    const [candidates, match] = resultsFor("reconciliation");
    assert.equal(candidates.text, "[]");
    assert.match(match.text, /Amounts differ: bank 1000\.00, invoice 1070/);
    assert.equal((await owner("select count(*)::int as n from reconciliations"))[0].n, 0);
  });
});

describe("collections", () => {
  test("drafts, never sends", async () => {
    const { result } = run("collections", {
      collections: [
        [{ tool: "draft_reminder", input: { customer_invoice_id: 1, body: "Estimados, les recordamos la factura FV-1001 por B/. 1,070.00, vencida el 30/09/2026." } }],
        { text: "Drafted." },
      ],
    });
    await result;
    assert.equal((await owner("select status from reminder_drafts"))[0].status, "draft");
    await assert.rejects(
      books.asAgent("agent_collections", (q) => q("update reminder_drafts set status = 'sent'")),
      /permission denied/,
    );
  });
});

describe("archive", () => {
  test("answers from the records and can't write anything", async () => {
    const { result, resultsFor } = run("archive", {
      archive: [[{ tool: "search_invoices", input: { text: "Las Lajas" } }], { text: "FV-1001 is open." }],
    });
    await result;
    assert.match(resultsFor("archive")[0].text, /FV-1001/);
    for (const sql of [
      "update customer_invoices set paid = true",
      "insert into reconciliations (bank_line_id, customer_invoice_id) values (4, 1)",
      "delete from supplier_invoices",
    ]) {
      await assert.rejects(books.asAgent("agent_archive", (q) => q(sql)), /permission denied/);
    }
  });
});

describe("audit", () => {
  test("every write is attributed to the agent's role, every call is logged", async () => {
    const { result } = run("billing", {
      billing: [[{ tool: "issue_invoice", input: { order_id: 502 } }, { tool: "issue_invoice", input: { order_id: 999 } }], { text: "x" }],
    });
    await result;
    const audit = await owner(
      "select actor, table_name, action from audit_log where actor like 'agent_%' order by id",
    );
    assert.deepEqual(audit, [
      { actor: "agent_billing", table_name: "customer_invoices", action: "insert" },
      { actor: "agent_billing", table_name: "customer_orders", action: "update" },
    ]);
    const actions = await owner("select agent, tool, ok from agent_actions order by id");
    assert.deepEqual(actions, [
      { agent: "billing", tool: "issue_invoice", ok: true },
      { agent: "billing", tool: "issue_invoice", ok: false },
    ]);
  });

  test("no agent can rewrite the audit trail or the action log", async () => {
    for (const sql of ["delete from audit_log", "update agent_actions set ok = true", "insert into audit_log (actor, table_name, action, row_data) values ('x','y','z','{}')"]) {
      await assert.rejects(books.asAgent("agent_orchestrator", (q) => q(sql)), /permission denied/);
    }
  });
});

describe("harness", () => {
  test("a refusal becomes an escalation", async () => {
    const { result } = run("intake", { intake: [{ stop: "refusal" }] });
    assert.equal((await result).outcome, "escalated");
    assert.match((await owner("select reason from escalations"))[0].reason as string, /declined/);
  });

  test("a runaway loop is stopped and escalated", async () => {
    const loop: Turn[] = Array.from({ length: 3 }, () => [{ tool: "list_inbox", input: {} }]);
    const { result } = run("intake", { intake: loop }, 3);
    const r = await result;
    assert.equal(r.outcome, "escalated");
    assert.match(r.summary, /after 3 turns/);
  });

  test("bad input is returned to the model, not executed", async () => {
    const { result, resultsFor } = run("billing", {
      billing: [[{ tool: "issue_invoice", input: { order_id: "501; drop table customer_invoices" } }], { text: "x" }],
    });
    await result;
    assert.equal(resultsFor("billing")[0].error, true);
    assert.equal((await owner("select count(*)::int as n from customer_invoices"))[0].n, 3);
  });
});

describe("orchestrator", () => {
  test("delegates to the agent that owns the work and gets its summary back", async () => {
    const { result, requests, resultsFor } = run("orchestrator", {
      orchestrator: [
        [{ tool: "books_status", input: {} }],
        [{ tool: "delegate", input: { agent: "billing", task: "Invoice the delivered orders." } }],
        { text: "Billing issued one invoice." },
      ],
      billing: [[{ tool: "issue_invoice", input: { order_id: 502 } }], { text: "Issued FV-1004." }],
    });
    assert.equal((await result).outcome, "done");
    assert.match(resultsFor("orchestrator")[1].text, /Issued FV-1004/);
    // Workers aren't offered delegate; the orchestrator isn't offered any write.
    assert.ok(!requests.find((r) => r.agent === "billing")!.tools.some((t) => t.name === "delegate"));
    assert.deepEqual(
      requests[0].tools.map((t) => t.name).sort(),
      ["books_status", "delegate", "escalate"],
    );
  });
});
