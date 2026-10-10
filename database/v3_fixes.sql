-- =====================================================================================
-- MultiEats v3 fixes  (IDEMPOTENT: only CREATE OR REPLACE, never drops tables or deletes data)
-- Apply on an existing database with:   cd backend && npm run apply-patch
--  1. Delivered sub-orders are LOCKED: the restaurant can no longer change the status afterwards.
--  2. "Release all payable" with nothing payable no longer reports a fake success.
--  3. Restaurant order list: LIMIT was applied before ORDER BY, so newest orders could go missing.
--  4. New restaurant can be added from the shared restaurant panel account.
-- =====================================================================================

-- ---------- 1. status lock after delivery ----------
CREATE OR REPLACE FUNCTION sp_update_sub_order_status(p_actor INT, p_id INT, p_status TEXT, p_reason TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_s SubOrders%ROWTYPE; v_ref Refunds%ROWTYPE;
BEGIN
  PERFORM sp_require_staff(p_actor);
  IF p_status IS NULL OR p_status NOT IN ('pending', 'preparing', 'ready', 'delivered', 'cancelled') THEN PERFORM sp_fail(400, 'Invalid status'); END IF;
  SELECT * INTO v_s FROM SubOrders WHERE sub_order_id = p_id AND restaurant_id = sp_staff_restaurant(p_actor) FOR UPDATE;
  IF NOT FOUND THEN PERFORM sp_fail(404, 'Sub-order not found or not owned by your restaurant'); END IF;
  IF v_s.sub_status = 'cancelled' THEN PERFORM sp_fail(409, 'Sub-order already cancelled'); END IF;
  -- LOCK: delivered is a final state (money, settlement and customer history depend on it)
  IF v_s.sub_status = 'delivered' THEN PERFORM sp_fail(409, 'This sub-order is already delivered. Its status is locked and cannot be changed'); END IF;

  UPDATE SubOrders SET sub_status = p_status WHERE sub_order_id = p_id;
  IF p_status = 'cancelled' THEN
    INSERT INTO Refunds (sub_order_id, amount, reason)
         VALUES (p_id, v_s.sub_amount, COALESCE(NULLIF(p_reason, ''), 'Cancelled by restaurant')) RETURNING * INTO v_ref;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM SubOrders WHERE order_id = v_s.order_id AND sub_status <> 'cancelled') THEN
    UPDATE Orders SET overall_status = 'cancelled' WHERE order_id = v_s.order_id;
  ELSIF NOT EXISTS (SELECT 1 FROM SubOrders WHERE order_id = v_s.order_id AND sub_status NOT IN ('delivered', 'cancelled')) THEN
    UPDATE Orders SET overall_status = 'completed' WHERE order_id = v_s.order_id;
  END IF;
  RETURN jsonb_build_object('message', 'Status updated', 'refund', CASE WHEN p_status = 'cancelled' THEN to_jsonb(v_ref) END);
END $$;

-- ---------- 2. release all: honest answer when nothing is payable ----------
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

-- ---------- 3. restaurant order list: newest 100 orders, newest first ----------
CREATE OR REPLACE FUNCTION sp_admin_orders(p_actor INT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_rid INT; BEGIN PERFORM sp_require_owner(p_actor); v_rid:=sp_owner_restaurant(p_actor); RETURN COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.order_id DESC) FROM (
 SELECT o.order_id,o.created_at,so.sub_amount,so.sub_status,o.overall_status,so.sub_order_id,o.delivery_address,u.name customer,u.phone,p.status payment_status,
 CASE WHEN so.sub_status='cancelled' THEN NULL ELSE da.status END delivery_status,
 CASE WHEN so.sub_status='cancelled' THEN NULL ELSE dp.name END partner,
 r.name restaurant,
 (so.sub_order_id=(SELECT MIN(so2.sub_order_id) FROM SubOrders so2 WHERE so2.order_id=o.order_id AND so2.sub_status<>'cancelled')) is_main_restaurant,
 (da.order_id IS NULL AND so.sub_order_id=(SELECT MIN(so2.sub_order_id) FROM SubOrders so2 WHERE so2.order_id=o.order_id AND so2.sub_status<>'cancelled')) can_assign_delivery,
 CASE WHEN so.sub_status='cancelled' THEN 'No delivery assignment for cancelled restaurant' WHEN da.order_id IS NULL THEN 'Waiting for delivery partner assignment' ELSE 'Delivery partner assigned' END delivery_assignment_status
 FROM SubOrders so JOIN Orders o ON o.order_id=so.order_id JOIN Users u ON u.user_id=o.user_id JOIN Restaurants r ON r.restaurant_id=so.restaurant_id LEFT JOIN Payments p ON p.order_id=o.order_id LEFT JOIN DeliveryAssignment da ON da.order_id=o.order_id LEFT JOIN DeliveryPartners dp ON dp.partner_id=da.partner_id
 WHERE so.restaurant_id=v_rid ORDER BY o.order_id DESC LIMIT 100) t),'[]'); END $$;

-- ---------- 4. add a new restaurant (shared restaurant-panel account only) ----------
CREATE OR REPLACE FUNCTION sp_owner_add_restaurant(p_actor INT, p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_r Restaurants%ROWTYPE; v_name TEXT; v_addr TEXT; v_photo TEXT;
        v_lat DOUBLE PRECISION; v_lng DOUBLE PRECISION; v_cost INT; v_prep INT;
BEGIN
  PERFORM sp_require_portal(p_actor);                      -- a single-restaurant account can never add restaurants
  v_name := trim(COALESCE(p->>'name', '')); v_addr := NULLIF(trim(COALESCE(p->>'address', '')), '');
  v_photo := NULLIF(trim(COALESCE(p->>'photo_url', '')), '');
  IF v_name = '' THEN PERFORM sp_fail(400, 'Restaurant name is required'); END IF;
  IF char_length(v_name) > 120 THEN PERFORM sp_fail(400, 'Restaurant name is too long (maximum 120 characters)'); END IF;
  BEGIN
    v_lat := NULLIF(trim(COALESCE(p->>'lat', '')), '')::double precision;
    v_lng := NULLIF(trim(COALESCE(p->>'lng', '')), '')::double precision;
    v_cost := NULLIF(trim(COALESCE(p->>'cost_for_two', '')), '')::int;
    v_prep := COALESCE(NULLIF(trim(COALESCE(p->>'prep_time_min', '')), '')::int, 20);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    PERFORM sp_fail(400, 'Latitude, longitude, cost and prep time must be valid numbers');
  END;
  IF v_lat IS NULL OR v_lng IS NULL THEN PERFORM sp_fail(400, 'Latitude and longitude are required (delivery distance is calculated from them)'); END IF;
  IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 THEN PERFORM sp_fail(400, 'Latitude or longitude is out of range'); END IF;
  IF v_cost IS NOT NULL AND v_cost NOT BETWEEN 0 AND 100000 THEN PERFORM sp_fail(400, 'Cost for two must be between 0 and 100000'); END IF;
  IF v_prep NOT BETWEEN 5 AND 180 THEN PERFORM sp_fail(400, 'Prep time must be between 5 and 180 minutes'); END IF;
  IF v_photo IS NOT NULL AND v_photo !~* '^(https?://|images/)[^[:space:]''"()<>]+$' THEN
    PERFORM sp_fail(400, 'Photo URL must start with http://, https:// or images/ and contain no spaces or quotes');
  END IF;
  IF EXISTS (SELECT 1 FROM Restaurants WHERE lower(name) = lower(v_name) AND lower(COALESCE(address, '')) = lower(COALESCE(v_addr, ''))) THEN
    PERFORM sp_fail(409, 'A restaurant with this name and address already exists');
  END IF;
  INSERT INTO Restaurants (name, address, area, cuisine_type, photo_url, cost_for_two, prep_time_min, lat, lng)
       VALUES (v_name, v_addr, NULLIF(trim(COALESCE(p->>'area', '')), ''), NULLIF(trim(COALESCE(p->>'cuisine_type', '')), ''),
               v_photo, v_cost, v_prep, v_lat, v_lng) RETURNING * INTO v_r;
  UPDATE Users SET restaurant_id = v_r.restaurant_id WHERE user_id = p_actor;   -- open the new restaurant's panel right away
  RETURN to_jsonb(v_r);
END $$;
