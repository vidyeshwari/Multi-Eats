-- =====================================================================================
-- MultiEats v2 upgrade  (IDEMPOTENT: safe to run on a fresh DB, on local pgAdmin and on Neon, any number of times.
-- It never drops a table and never deletes data.)
--
--  1. PAYMENT SAFETY  : the customer pays MultiEats (one Payments row). No restaurant ever holds another
--                       restaurant's money. Each restaurant's share is a row in Settlements (escrow ledger):
--                       held -> payable (after delivery) -> paid (MultiEats pays out) -> confirmed (restaurant confirms)
--                       or disputed / refunded.
--  2. PHONE RULE      : exactly 10 digits and must start with 7, 8 or 9.
--  3. ONE RESTAURANT LOGIN : one shared account can select any restaurant and then sees ONLY that restaurant's panel.
--  4. CHART QUERIES   : "Orders per customer" for the main admin and for the restaurant panel.
--  5. VIEWS           : vw_order_summary, vw_restaurant_payables.
-- Run order for a fresh DB: schema.sql -> procedures.sql -> seed.sql -> v2_upgrade.sql
-- =====================================================================================

-- ---------- 0. settings ----------
INSERT INTO AppConfig (key, value, note) VALUES
  ('platform_commission_pct', 10, 'MultiEats commission taken from each restaurant share (%)'),
  ('payout_sla_hours',        24, 'Hours after delivery within which MultiEats must pay the restaurant')
ON CONFLICT (key) DO NOTHING;

-- ---------- 1. Settlements = escrow ledger (who is owed what, and has it been paid) ----------
CREATE TABLE IF NOT EXISTS Settlements (
  settlement_id     SERIAL PRIMARY KEY,
  order_id          INT NOT NULL REFERENCES Orders(order_id) ON DELETE CASCADE,
  sub_order_id      INT NOT NULL UNIQUE REFERENCES SubOrders(sub_order_id) ON DELETE CASCADE,
  restaurant_id     INT NOT NULL REFERENCES Restaurants(restaurant_id),
  gross_amount      NUMERIC(10,2) NOT NULL CHECK (gross_amount >= 0),
  commission_amount NUMERIC(10,2) NOT NULL CHECK (commission_amount >= 0),
  net_amount        NUMERIC(10,2) NOT NULL CHECK (net_amount >= 0),
  status            VARCHAR(12) NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held','payable','paid','confirmed','disputed','refunded')),
  payable_at        TIMESTAMPTZ,
  payout_ref        VARCHAR(60),
  paid_at           TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  dispute_note      VARCHAR(300),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settle_rest ON Settlements(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_settle_order ON Settlements(order_id);

-- ---------- 2. Users: shared restaurant login flag + phone rule ----------
ALTER TABLE Users ADD COLUMN IF NOT EXISTS can_switch_restaurant BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_format') THEN
    -- NOT VALID: old rows are left alone, every new/updated row must follow the rule
    ALTER TABLE Users ADD CONSTRAINT users_phone_format
      CHECK (phone IS NULL OR phone ~ '^[789][0-9]{9}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_customer_phone_required') THEN
    ALTER TABLE Users ADD CONSTRAINT users_customer_phone_required
      CHECK (role <> 'customer' OR phone IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- ---------- 3. Signup: strict validation (password strength is checked in the gateway, before hashing) ----------
CREATE OR REPLACE FUNCTION sp_signup(p_name TEXT, p_email TEXT, p_hash TEXT, p_phone TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_u Users%ROWTYPE; v_phone TEXT := trim(COALESCE(p_phone, '')); v_email TEXT := lower(trim(COALESCE(p_email, '')));
BEGIN
  IF NULLIF(trim(COALESCE(p_name, '')), '') IS NULL OR v_email = '' OR p_hash IS NULL THEN
    PERFORM sp_fail(400, 'Name, email and password are required');
  END IF;
  IF char_length(trim(p_name)) > 100 THEN PERFORM sp_fail(400, 'Name is too long (maximum 100 characters)'); END IF;
  IF char_length(v_email) > 120 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    PERFORM sp_fail(400, 'Enter a valid email address');
  END IF;
  IF v_phone !~ '^[789][0-9]{9}$' THEN
    PERFORM sp_fail(400, 'Phone number must be exactly 10 digits and start with 7, 8 or 9');
  END IF;
  INSERT INTO Users (name, email, password_hash, phone, role)
       VALUES (trim(p_name), v_email, p_hash, v_phone, 'customer') RETURNING * INTO v_u;
  RETURN jsonb_build_object('user', jsonb_build_object('user_id', v_u.user_id, 'name', v_u.name, 'email', v_u.email));
EXCEPTION WHEN unique_violation THEN
  PERFORM sp_fail(409, 'Email already registered');
END $$;

CREATE OR REPLACE FUNCTION sp_get_login(p_email TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('user_id', user_id, 'name', name, 'email', email, 'role', role, 'password_hash', password_hash,
                            'portal', can_switch_restaurant, 'restaurant_id', restaurant_id)
    FROM Users WHERE email = lower(trim(p_email))
$$;

-- ---------- 4. ONE shared restaurant login (selects a restaurant, then sees only that restaurant) ----------
CREATE OR REPLACE FUNCTION sp_require_owner(p_actor INT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_actor IS NULL THEN PERFORM sp_fail(401, 'Please log in'); END IF;
  IF NOT EXISTS (SELECT 1 FROM Users WHERE user_id = p_actor AND role = 'restaurant_owner'
                   AND (restaurant_id IS NOT NULL OR can_switch_restaurant)) THEN
    PERFORM sp_fail(403, 'Only a restaurant owner can perform this action');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sp_owner_restaurant(p_actor INT) RETURNS INT LANGUAGE plpgsql STABLE AS $$
DECLARE v_rid INT;
BEGIN
  PERFORM sp_require_owner(p_actor);
  SELECT restaurant_id INTO v_rid FROM Users WHERE user_id = p_actor;
  IF v_rid IS NULL THEN PERFORM sp_fail(409, 'Please select a restaurant first'); END IF;
  RETURN v_rid;
END $$;

CREATE OR REPLACE FUNCTION sp_require_portal(p_actor INT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_actor IS NULL THEN PERFORM sp_fail(401, 'Please log in'); END IF;
  IF NOT EXISTS (SELECT 1 FROM Users WHERE user_id = p_actor AND role = 'restaurant_owner' AND can_switch_restaurant) THEN
    PERFORM sp_fail(403, 'Only the shared restaurant account can choose a restaurant');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sp_create_portal_user(p_name TEXT, p_email TEXT, p_hash TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_u Users%ROWTYPE;
BEGIN
  INSERT INTO Users (name, email, password_hash, role, restaurant_id, is_platform_admin, can_switch_restaurant)
       VALUES (p_name, lower(trim(p_email)), p_hash, 'restaurant_owner', NULL, FALSE, TRUE)
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name,
       role = 'restaurant_owner', is_platform_admin = FALSE, can_switch_restaurant = TRUE
  RETURNING * INTO v_u;
  RETURN jsonb_build_object('user_id', v_u.user_id, 'email', v_u.email, 'role', v_u.role, 'portal', TRUE);
END $$;

CREATE OR REPLACE FUNCTION sp_portal_restaurants(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_sel INT;
BEGIN
  PERFORM sp_require_portal(p_actor);
  SELECT restaurant_id INTO v_sel FROM Users WHERE user_id = p_actor;
  RETURN jsonb_build_object('selected', v_sel,
    'restaurants', COALESCE((SELECT jsonb_agg(jsonb_build_object('restaurant_id', r.restaurant_id, 'name', r.name,
                                  'area', r.area, 'cuisine_type', r.cuisine_type) ORDER BY r.name)
                               FROM Restaurants r), '[]'));
END $$;

CREATE OR REPLACE FUNCTION sp_portal_select_restaurant(p_actor INT, p_rid INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_r Restaurants%ROWTYPE;
BEGIN
  PERFORM sp_require_portal(p_actor);
  SELECT * INTO v_r FROM Restaurants WHERE restaurant_id = p_rid;
  IF NOT FOUND THEN PERFORM sp_fail(404, 'Restaurant not found'); END IF;
  UPDATE Users SET restaurant_id = p_rid WHERE user_id = p_actor;
  RETURN jsonb_build_object('restaurant_id', v_r.restaurant_id, 'name', v_r.name);
END $$;

-- ---------- 5. PAYMENT SAFETY ----------
-- one settlement row per (non-cancelled) sub-order, created when the customer's payment is received by MultiEats
CREATE OR REPLACE FUNCTION sp_create_settlements(p_order INT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_pct NUMERIC := COALESCE(sp_cfg('platform_commission_pct'), 0); v_n INT;
BEGIN
  INSERT INTO Settlements (order_id, sub_order_id, restaurant_id, gross_amount, commission_amount, net_amount, status, payable_at)
  SELECT so.order_id, so.sub_order_id, so.restaurant_id, so.sub_amount,
         round(so.sub_amount * v_pct / 100, 2), so.sub_amount - round(so.sub_amount * v_pct / 100, 2),
         CASE WHEN so.sub_status = 'delivered' THEN 'payable' ELSE 'held' END,
         CASE WHEN so.sub_status = 'delivered' THEN NOW() END
    FROM SubOrders so WHERE so.order_id = p_order AND so.sub_status <> 'cancelled'
  ON CONFLICT (sub_order_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- only the CUSTOMER can pay. The money goes to MultiEats (escrow), never to the "main" restaurant.
CREATE OR REPLACE FUNCTION sp_pay_order(p_actor INT, p_order INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_p Payments%ROWTYPE; v_o Orders%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN PERFORM sp_fail(401, 'Please log in'); END IF;
  SELECT * INTO v_o FROM Orders WHERE order_id = p_order AND user_id = p_actor;
  IF NOT FOUND THEN PERFORM sp_fail(404, 'Order not found'); END IF;
  IF v_o.overall_status = 'cancelled' THEN PERFORM sp_fail(409, 'This order is cancelled'); END IF;
  UPDATE Payments SET status = 'paid', paid_at = NOW() WHERE order_id = p_order AND status = 'unpaid' RETURNING * INTO v_p;
  IF NOT FOUND THEN PERFORM sp_fail(409, 'Already paid'); END IF;
  PERFORM sp_create_settlements(p_order);
  RETURN to_jsonb(v_p) || jsonb_build_object('held_by', 'MultiEats',
         'message', 'Payment received by MultiEats and held safely until each restaurant delivers its part');
END $$;

-- the ledger follows the sub-order status automatically (so no code path can forget it)
CREATE OR REPLACE FUNCTION trg_settlement_sync() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_st TEXT;
BEGIN
  IF NEW.sub_status IS NOT DISTINCT FROM OLD.sub_status THEN RETURN NEW; END IF;
  SELECT status INTO v_st FROM Settlements WHERE sub_order_id = NEW.sub_order_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.sub_status = 'delivered' AND v_st = 'held' THEN
    UPDATE Settlements SET status = 'payable', payable_at = NOW() WHERE sub_order_id = NEW.sub_order_id;
  ELSIF NEW.sub_status = 'cancelled' THEN
    IF v_st IN ('paid', 'confirmed', 'disputed') THEN
      PERFORM sp_fail(409, 'Cannot cancel: the payout for this sub-order has already been released');
    END IF;
    UPDATE Settlements SET status = 'refunded' WHERE sub_order_id = NEW.sub_order_id;
  ELSIF NEW.sub_status <> 'delivered' AND v_st = 'payable' THEN
    UPDATE Settlements SET status = 'held', payable_at = NULL WHERE sub_order_id = NEW.sub_order_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS settlement_sync ON SubOrders;
CREATE TRIGGER settlement_sync AFTER UPDATE OF sub_status ON SubOrders
  FOR EACH ROW EXECUTE FUNCTION trg_settlement_sync();

-- MultiEats (main admin) pays a restaurant its share. Only delivered (payable) shares can be released.
CREATE OR REPLACE FUNCTION sp_platform_release_payout(p_actor INT, p_id INT, p_ref TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_s Settlements%ROWTYPE;
BEGIN
  PERFORM sp_require_platform_admin(p_actor);
  UPDATE Settlements SET status = 'paid', paid_at = NOW(),
         payout_ref = COALESCE(NULLIF(trim(p_ref), ''), 'PAY-' || settlement_id || '-' || to_char(NOW(), 'YYMMDDHH24MISS'))
   WHERE settlement_id = p_id AND status = 'payable' RETURNING * INTO v_s;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM Settlements WHERE settlement_id = p_id) THEN PERFORM sp_fail(404, 'Settlement not found'); END IF;
    PERFORM sp_fail(409, 'Only delivered (payable) shares that are not yet paid can be released');
  END IF;
  RETURN jsonb_build_object('message', 'Payout released', 'settlement_id', v_s.settlement_id, 'net_amount', v_s.net_amount, 'payout_ref', v_s.payout_ref);
END $$;

CREATE OR REPLACE FUNCTION sp_platform_release_all(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_n INT; v_sum NUMERIC;
BEGIN
  PERFORM sp_require_platform_admin(p_actor);
  WITH u AS (UPDATE Settlements SET status = 'paid', paid_at = NOW(),
                    payout_ref = 'PAY-' || settlement_id || '-' || to_char(NOW(), 'YYMMDDHH24MISS')
              WHERE status = 'payable' RETURNING net_amount)
  SELECT COUNT(*), COALESCE(SUM(net_amount), 0) INTO v_n, v_sum FROM u;
  RETURN jsonb_build_object('message', CASE WHEN v_n = 0 THEN 'Nothing to release: no payable payouts' ELSE 'Payouts released' END,
                            'count', v_n, 'total', v_sum);
END $$;

-- the restaurant confirms (or disputes) that the money really reached it
CREATE OR REPLACE FUNCTION sp_owner_confirm_payout(p_actor INT, p_id INT, p_received BOOLEAN, p_note TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_rid INT; v_s Settlements%ROWTYPE;
BEGIN
  PERFORM sp_require_owner(p_actor); v_rid := sp_owner_restaurant(p_actor);
  SELECT * INTO v_s FROM Settlements WHERE settlement_id = p_id AND restaurant_id = v_rid FOR UPDATE;
  IF NOT FOUND THEN PERFORM sp_fail(404, 'Settlement not found for your restaurant'); END IF;
  IF COALESCE(p_received, TRUE) THEN
    IF v_s.status NOT IN ('paid', 'disputed') THEN PERFORM sp_fail(409, 'Only a paid payout can be confirmed'); END IF;
    UPDATE Settlements SET status = 'confirmed', confirmed_at = NOW(), dispute_note = NULL WHERE settlement_id = p_id;
    RETURN jsonb_build_object('message', 'Payout confirmed', 'status', 'confirmed');
  END IF;
  IF v_s.status <> 'paid' THEN PERFORM sp_fail(409, 'Only a paid payout can be disputed'); END IF;
  IF NULLIF(trim(COALESCE(p_note, '')), '') IS NULL THEN PERFORM sp_fail(400, 'Please write why you did not receive the money'); END IF;
  UPDATE Settlements SET status = 'disputed', dispute_note = left(trim(p_note), 300) WHERE settlement_id = p_id;
  RETURN jsonb_build_object('message', 'Dispute raised with MultiEats', 'status', 'disputed');
END $$;

CREATE OR REPLACE FUNCTION sp_owner_settlements(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_rid INT;
BEGIN
  PERFORM sp_require_owner(p_actor); v_rid := sp_owner_restaurant(p_actor);
  RETURN jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
        'held', COALESCE(SUM(net_amount) FILTER (WHERE status = 'held'), 0),
        'payable', COALESCE(SUM(net_amount) FILTER (WHERE status = 'payable'), 0),
        'paid', COALESCE(SUM(net_amount) FILTER (WHERE status = 'paid'), 0),
        'confirmed', COALESCE(SUM(net_amount) FILTER (WHERE status = 'confirmed'), 0),
        'disputed', COALESCE(SUM(net_amount) FILTER (WHERE status = 'disputed'), 0),
        'refunded', COALESCE(SUM(gross_amount) FILTER (WHERE status = 'refunded'), 0))
        FROM Settlements WHERE restaurant_id = v_rid),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.settlement_id DESC) FROM (
        SELECT s.settlement_id, s.order_id, s.sub_order_id, s.gross_amount, s.commission_amount, s.net_amount, s.status,
               s.payable_at, s.paid_at, s.payout_ref, s.confirmed_at, s.dispute_note, s.created_at
          FROM Settlements s WHERE s.restaurant_id = v_rid ORDER BY s.settlement_id DESC LIMIT 200) t), '[]'));
END $$;

CREATE OR REPLACE FUNCTION sp_platform_settlements(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_sla NUMERIC := COALESCE(sp_cfg('payout_sla_hours'), 24);
BEGIN
  PERFORM sp_require_platform_admin(p_actor);
  RETURN jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
        'held', COALESCE(SUM(net_amount) FILTER (WHERE status = 'held'), 0),
        'payable', COALESCE(SUM(net_amount) FILTER (WHERE status = 'payable'), 0),
        'paid', COALESCE(SUM(net_amount) FILTER (WHERE status = 'paid'), 0),
        'confirmed', COALESCE(SUM(net_amount) FILTER (WHERE status = 'confirmed'), 0),
        'disputed', COALESCE(SUM(net_amount) FILTER (WHERE status = 'disputed'), 0),
        'refunded', COALESCE(SUM(gross_amount) FILTER (WHERE status = 'refunded'), 0),
        'commission', COALESCE(SUM(commission_amount) FILTER (WHERE status <> 'refunded'), 0),
        'overdue', COUNT(*) FILTER (WHERE status = 'payable' AND payable_at < NOW() - make_interval(hours => v_sla::int)),
        'disputes', COUNT(*) FILTER (WHERE status = 'disputed'),
        'gross_total', COALESCE(SUM(gross_amount) FILTER (WHERE status <> 'refunded'), 0)) FROM Settlements),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.settlement_id DESC) FROM (
        SELECT s.settlement_id, s.order_id, s.sub_order_id, s.restaurant_id, r.name AS restaurant, s.gross_amount,
               s.commission_amount, s.net_amount, s.status, s.payable_at, s.paid_at, s.payout_ref, s.confirmed_at, s.dispute_note,
               (s.status = 'payable' AND s.payable_at < NOW() - make_interval(hours => v_sla::int)) AS overdue
          FROM Settlements s JOIN Restaurants r ON r.restaurant_id = s.restaurant_id
         ORDER BY s.settlement_id DESC LIMIT 300) t), '[]'));
END $$;

-- ---------- 6. CHART data: "Orders per customer" ----------
CREATE OR REPLACE FUNCTION sp_platform_orders_per_customer(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sp_require_platform_admin(p_actor);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
    SELECT u.name, COUNT(*)::int AS orders FROM Orders o JOIN Users u ON u.user_id = o.user_id
     GROUP BY u.user_id, u.name ORDER BY COUNT(*) DESC, u.name LIMIT 10) t), '[]');
END $$;

CREATE OR REPLACE FUNCTION sp_owner_orders_per_customer(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_rid INT;
BEGIN
  PERFORM sp_require_owner(p_actor); v_rid := sp_owner_restaurant(p_actor);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
    SELECT u.name, COUNT(DISTINCT so.order_id)::int AS orders
      FROM SubOrders so JOIN Orders o ON o.order_id = so.order_id JOIN Users u ON u.user_id = o.user_id
     WHERE so.restaurant_id = v_rid GROUP BY u.user_id, u.name ORDER BY COUNT(DISTINCT so.order_id) DESC, u.name LIMIT 10) t), '[]');
END $$;

-- ---------- 7. Views ----------
CREATE OR REPLACE VIEW vw_order_summary AS
SELECT o.order_id, u.name AS customer, r.name AS restaurant, so.sub_amount, so.sub_status,
       o.overall_status, p.status AS payment_status, o.created_at
  FROM Orders o JOIN Users u ON u.user_id = o.user_id
  JOIN SubOrders so ON so.order_id = o.order_id
  JOIN Restaurants r ON r.restaurant_id = so.restaurant_id
  LEFT JOIN Payments p ON p.order_id = o.order_id;

CREATE OR REPLACE VIEW vw_restaurant_payables AS
SELECT r.restaurant_id, r.name AS restaurant,
       COALESCE(SUM(s.net_amount) FILTER (WHERE s.status = 'held'), 0)      AS held,
       COALESCE(SUM(s.net_amount) FILTER (WHERE s.status = 'payable'), 0)   AS payable,
       COALESCE(SUM(s.net_amount) FILTER (WHERE s.status IN ('paid','confirmed')), 0) AS paid_out,
       COUNT(s.settlement_id) AS shares
  FROM Restaurants r LEFT JOIN Settlements s ON s.restaurant_id = r.restaurant_id
 GROUP BY r.restaurant_id, r.name;

-- ---------- 8. Back-fill: orders that were already paid before this upgrade ----------
DO $$ DECLARE v_o INT;
BEGIN
  FOR v_o IN SELECT p.order_id FROM Payments p WHERE p.status = 'paid'
              AND NOT EXISTS (SELECT 1 FROM Settlements s WHERE s.order_id = p.order_id) LOOP
    PERFORM sp_create_settlements(v_o);
  END LOOP;
END $$;
