/**
 * Database-level integrity guarantees, applied idempotently after the tables exist.
 *  - journal entries must balance (deferred constraint trigger)
 *  - journal lines / entries / audit logs are append-only
 *  - transactions can never be deleted; only status completed -> reversed is allowed
 *  - savings balances & loan paid totals can only change inside ledger services
 *    (which set app.ledger_write = 'on' for the transaction)
 */
export const SETUP_SQL = `
CREATE OR REPLACE FUNCTION fn_journal_balanced() RETURNS trigger AS $$
DECLARE diff numeric;
BEGIN
  SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) INTO diff FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF diff <> 0 THEN RAISE EXCEPTION 'Journal entry % is unbalanced by %', NEW.entry_id, diff; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_journal_balanced();

CREATE OR REPLACE FUNCTION fn_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% on % is not permitted: financial records are immutable (use a reversal)', TG_OP, TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_immutable_lines ON journal_lines;
CREATE TRIGGER trg_immutable_lines BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION fn_immutable();
DROP TRIGGER IF EXISTS trg_immutable_entries ON journal_entries;
CREATE TRIGGER trg_immutable_entries BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION fn_immutable();
DROP TRIGGER IF EXISTS trg_immutable_audit ON audit_logs;
CREATE TRIGGER trg_immutable_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION fn_immutable();
DROP TRIGGER IF EXISTS trg_immutable_gentries ON group_entries;
CREATE TRIGGER trg_immutable_gentries BEFORE UPDATE OR DELETE ON group_entries FOR EACH ROW EXECUTE FUNCTION fn_immutable();

CREATE OR REPLACE FUNCTION fn_txn_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Transactions cannot be deleted; post a reversal instead'; END IF;
  IF NEW.amount <> OLD.amount OR NEW.type <> OLD.type OR NEW.org_id <> OLD.org_id OR NEW.reference <> OLD.reference
     OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.txn_date <> OLD.txn_date THEN
    RAISE EXCEPTION 'Financial fields of a transaction are immutable';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN RAISE EXCEPTION 'A reversed transaction cannot be reinstated'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_txn_guard ON transactions;
CREATE TRIGGER trg_txn_guard BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION fn_txn_guard();

CREATE OR REPLACE FUNCTION fn_balance_guard() RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('app.ledger_write', true), 'off') <> 'on' THEN
    IF TG_TABLE_NAME = 'savings_accounts' AND NEW.balance IS DISTINCT FROM OLD.balance THEN
      RAISE EXCEPTION 'Savings balances cannot be edited directly';
    END IF;
    IF TG_TABLE_NAME = 'loans' AND (NEW.principal_paid IS DISTINCT FROM OLD.principal_paid OR NEW.interest_paid IS DISTINCT FROM OLD.interest_paid OR NEW.penalty_paid IS DISTINCT FROM OLD.penalty_paid OR NEW.principal IS DISTINCT FROM OLD.principal) THEN
      RAISE EXCEPTION 'Loan balances cannot be edited directly';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sa_balance_guard ON savings_accounts;
CREATE TRIGGER trg_sa_balance_guard BEFORE UPDATE ON savings_accounts FOR EACH ROW EXECUTE FUNCTION fn_balance_guard();
DROP TRIGGER IF EXISTS trg_loan_balance_guard ON loans;
CREATE TRIGGER trg_loan_balance_guard BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION fn_balance_guard();
`;
