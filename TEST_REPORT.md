# MultiEats — Test Report

Generated: 2026-10-09T21:21:27.834Z  
Node v22.22.2 · linux · database food_delivery  
**Result: 92 / 92 PASSED**

Note: the project uses PostgreSQL; wherever the college sheet says "MySQL" the same test is executed on PostgreSQL. "Actual Result" is what the program really returned during this run.

## 20. Standard / Compulsory Test Cases

| Test ID | Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| ST-01 | Application launches | Application opens | HTTP 200, home page served; /health -> server up, database connected | PASS |
| ST-02 | Login: valid login | Login successful | HTTP 200, token issued, role=admin | PASS |
| ST-03 | Login: invalid password | Login rejected | HTTP 401 "Invalid email or password", no token | PASS |
| ST-04 | Input: empty mandatory field | Validation error | HTTP 400 "Name, email and password are required" | PASS |
| ST-05 | CREATE: add valid record (menu item) | Record inserted | HTTP 200; PostgreSQL row item_id=356, price=99.00, restaurant_id=1 | PASS |
| ST-06 | READ: view records | Correct records displayed | HTTP 200, 51 restaurants returned = 51 active rows in PostgreSQL | PASS |
| ST-07 | Search: search existing record | Correct record displayed | Search "blue": 1 result(s), identical to PostgreSQL ILIKE search; includes "Blue Nile" | PASS |
| ST-08 | UPDATE: update record (menu price) | Record updated | HTTP 200; PostgreSQL price is now 123.00 | PASS |
| ST-09 | DELETE: delete record (menu item) | Record deleted | HTTP 200; SELECT returns 0 rows for item_id=356 | PASS |
| ST-10 | PK: duplicate primary key | Rejected | Rejected (23505): duplicate key value violates unique constraint "users_pkey" | PASS |
| ST-11 | NOT NULL: NULL mandatory field | Rejected | Rejected (23502): null value in column "name" of relation "users" violates not-null constraint | PASS |
| ST-12 | UNIQUE: duplicate unique value (email) | Rejected | Rejected (23505): duplicate key value violates unique constraint "users_email_key" | PASS |
| ST-13 | FK: invalid foreign key | Rejected | Rejected (23503): insert or update on table "menuitems" violates foreign key constraint "menuitems_restaurant_id_fkey" | PASS |
| ST-14 | JOIN: execute JOIN | Correct result | 4-table JOIN (Orders-Users-SubOrders-Restaurants) returned 70 rows = 70 sub-orders | PASS |
| ST-15 | Aggregate: execute aggregate | Correct result | SUM per restaurant (GROUP BY) added together = 73115.00 = overall SUM 73115.00 | PASS |
| ST-16 | View: execute view | Correct result | vw_order_summary returned 70 rows = 70 sub-orders | PASS |
| ST-17 | Integration: Frontend -> Backend | Request processed | POST /orders with Authorization header -> HTTP 200, order #52 created, total 1154.77 | PASS |
| ST-18 | Integration: Backend -> PostgreSQL (MySQL in sheet) | Correct operation | Signup via API -> HTTP 200 and the user row (id 69) exists in PostgreSQL | PASS |
| ST-19 | Database: PostgreSQL (MySQL in sheet) -> Backend | Correct response | Row inserted directly in PostgreSQL ("zz_db_9bd398a1") is returned by GET /restaurants/1 | PASS |
| ST-20 | Error: backend unavailable | Error handled | Server stopped: request fails (ECONNREFUSED); frontend api() catches it and shows "Cannot reach backend. Is npm start running?" | PASS |

## 21. Edge Test Cases

| Test ID | Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| ET-01 | Empty input | Validation error | Blank signup -> 400 "Name, email and password are required"; blank login -> 401 "Invalid email or password" | PASS |
| ET-02 | Minimum value: price 0 | Accepted | Price 0 -> HTTP 200 accepted (item_id 359) | PASS |
| ET-03 | Below minimum: price -1 | Rejected | Price -1 -> HTTP 400 "Invalid input"; quantity 0 rejected by CHECK (23514) | PASS |
| ET-04 | Maximum value: price 999999.99 | Accepted | HTTP 200, stored price 999999.99 | PASS |
| ET-05 | Maximum + 1: price 1000000 | Rejected/handled | HTTP 400 "Invalid input" (numeric overflow handled, no crash) | PASS |
| ET-06 | Duplicate record (same email twice) | Rejected | First signup 200, second signup 409 "Email already registered" | PASS |
| ET-07 | Special characters @#$% | Safely handled | Stored exactly as typed (parameterised SQL); pages print names through esc() so <b> is shown as text | PASS |
| ET-08 | SQL injection: ' OR 1=1 -- | Rejected/safely handled | Login with injection -> 401 (no token); DROP TABLE text stored/rejected as plain data; Users table intact (20 rows) | PASS |
| ET-09 | Very large input | Handled correctly | 5000-char name -> 400 "Name is too long (maximum 100 characters)"; 300 KB body -> 413 "Request is too large" | PASS |
| ET-10 | Non-existing record | Proper message | Restaurant 99999999 -> 404 "Restaurant not found"; order 99999999 -> 404 "Order not found" | PASS |
| ET-11 | PostgreSQL (MySQL in sheet) unavailable | Error handled | With the database unreachable: /health -> 503 {database:"down"}; /restaurants -> 500 JSON "Something went wrong"; server stayed alive | PASS |
| ET-12 | Backend unavailable | Error handled | Request while Node server is stopped fails with ECONNREFUSED; UI shows "Cannot reach backend" | PASS |
| ET-13 | Invalid datatype | Rejected | id "abc" -> 400; lat "north" -> 400; item "abc" -> 400 (all "Invalid input") | PASS |
| ET-14 | Network interruption (request aborted mid-flight) | Error handled | Client aborted the request (AbortError); the server is still healthy afterwards (/health 200) | PASS |
| ET-15 | Transaction failure | Rollback | Order with one bad item -> 400, no order/sub-order saved; manual BEGIN..error..ROLLBACK also left counts unchanged (41 orders, 72 sub-orders) | PASS |
| ET-16 | Phone starts with 6 (10 digits) | Rejected | HTTP 400 "Phone number must be exactly 10 digits and start with 7, 8 or 9" | PASS |
| ET-17 | Phone with 9 digits / 11 digits | Rejected | 9 digits -> 400, 11 digits -> 400 ("Phone number must be exactly 10 digits and start with 7, 8 or 9") | PASS |
| ET-18 | Phone with letters / symbols / spaces | Rejected | 98765abcde, +919876543210, 98765 4321, 9876-54321 -> all HTTP 400 | PASS |
| ET-19 | Phone boundaries: 7000000000 / 8999999999 / 9999999999 | Accepted | All three boundary numbers accepted (HTTP 200) | PASS |
| ET-20 | Password length: 7 / 8 / 64 / 65 characters | Rejected below 8 and above 64, accepted 8-64 | 7 chars -> 400, 8 chars -> 200, 64 chars -> 200, 65 chars -> 400 | PASS |
| ET-21 | Release the same payout twice | Rejected | First release 200; second 409 "Only delivered (payable) shares that are not yet paid can be released"; unknown settlement 404 | PASS |

## Functional Test Cases (new features)

| Test ID | Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| FT-01 | Signup with valid phone starting 7, 8, 9 | Account created and login works | 7123456789, 8123456789, 9123456789 accepted and the users could log in | PASS |
| FT-02 | Invalid phone: no account and NO login | Error message shown, user cannot log in | Signup HTTP 400 "Phone number must be exactly 10 digits and start with 7, 8 or 9"; login afterwards HTTP 401, no token; 0 rows in Users | PASS |
| FT-03 | Missing phone | Rejected | HTTP 400 "Phone number must be exactly 10 digits and start with 7, 8 or 9" | PASS |
| FT-04 | Database also refuses an invalid phone (even if API is bypassed) | Rejected by CHECK constraint | Phone 1234567890 -> users_phone_format; NULL phone for a customer -> users_customer_phone_required | PASS |
| FT-05 | Weak passwords are rejected (9 different weak passwords) | Error message and NO login | 9 weak passwords -> HTTP 400 "Password is too weak..."; none could log in | PASS |
| FT-06 | Password containing the email name or the person's name | Rejected | "Password is too weak. It needs: must not contain your email name" | PASS |
| FT-07 | Strong password accepted and login works | Account created, login successful | Signup 200; login OK as zz_st_403a932f@test.com | PASS |
| FT-08 | Frontend (browser) applies the same rules before sending | Same rules in login.html | login.html shows live password checklist, limits phone to 10 digits; browser and server rules give identical results | PASS |
| FT-09 | ONE shared restaurant login | Login works; role restaurant_owner, portal=true | Logged in as zz_portal_0c4c3802@test.com, role restaurant_owner, portal=true | PASS |
| FT-10 | Before selecting a restaurant the panel shows nothing | Asked to select a restaurant (409) | orders/restaurants/settlements -> 409 "Please select a restaurant first" | PASS |
| FT-11 | Restaurant list for the selector | All restaurants listed | 51 restaurants = 51 in PostgreSQL | PASS |
| FT-12 | Select restaurant A: only A's panel | Only restaurant A data visible | Restaurants -> only "Blue Nile"; 6 orders, all of A; (B menu request returns nothing) own menu 13 items | PASS |
| FT-13 | Switch to restaurant B with the same login | Now only B data; A data hidden | Same token now shows only "Malaka Spice"; a new menu item was saved under restaurant 5 | PASS |
| FT-14 | Only the shared account may choose a restaurant | Others get 403 | single-restaurant owner 403, customer 403, admin 403, no token 401; owner A still bound to restaurant 1 | PASS |
| FT-15 | Select a non-existing / invalid restaurant | Rejected | 99999999 -> 404 "Restaurant not found"; "abc" -> 400 | PASS |
| FT-16 | Customer pays ONCE: the money is held by MultiEats, not by a restaurant | One payment; one settlement per restaurant, status held | 1 payment row; settlements: restaurant 1: 340.00 (held), restaurant 5: 780.00 (held) | PASS |
| FT-17 | Money adds up: payment = restaurant shares + delivery fee; share = commission + payout | Totals match to the paisa | Paid 1154.77 = shares 1120.00 + delivery fee 34.77; commission + payouts = 1120.00 | PASS |
| FT-18 | Each restaurant (including the first/main one) sees ONLY its own settlement | No restaurant sees another restaurant's money | Main restaurant A sees sub-order 97 only; restaurant B sees sub-order 98 only | PASS |
| FT-19 | A restaurant (even the main one) cannot take or mark the payment | Only the customer can pay | Main restaurant -> 404 "Order not found", admin -> 404; payment still "unpaid" | PASS |
| FT-20 | No payout before delivery | Release rejected (409) | Status "held" -> release HTTP 409 "Only delivered (payable) shares that are not yet paid can be released" | PASS |
| FT-21 | Main restaurant delivers its part: only ITS share becomes payable | A payable, B still held | Restaurant A share: payable; restaurant B share: held (not affected by A) | PASS |
| FT-22 | Only the main admin can release a payout | Others get 403 | restaurant owner 403, customer 403, shared restaurant login 403 | PASS |
| FT-23 | MultiEats releases the payout to the restaurant | Status paid with reference and time | HTTP 200; status paid, ref UTR123456, net 306.00 | PASS |
| FT-24 | Restaurant confirms it received the money | Status confirmed | Status confirmed at 2026-10-09T21:21:23.503Z | PASS |
| FT-25 | A restaurant cannot confirm / touch another restaurant's payout | Rejected (404) | Owner A on B's settlement -> 404 "Settlement not found for your restaurant" | PASS |
| FT-26 | Dispute: restaurant says money not received | Needs a reason; status disputed; visible to admin | No reason -> 400 "Please write why you did not receive the money"; with reason -> 200; admin sees status "disputed", note "Money not in my bank", open disputes 1 | PASS |
| FT-27 | Restaurant cancels its part: refund only that share, other share unaffected | B refunded, A held, order continues | B: refunded (refund 780.00); A: held; order status "confirmed" | PASS |
| FT-28 | Cannot cancel after the payout was released | Rejected (409), nothing changed | HTTP 409 "Cannot cancel: the payout for this sub-order has already been released"; sub-order still "delivered", 0 refunds | PASS |
| FT-29 | Settlement creation is idempotent (no double entries) | Second call creates 0 rows | Called again -> 0 new rows; still 2 settlements | PASS |
| FT-30 | Admin settlement summary equals the database | Totals match | held+payable+paid+confirmed+disputed = 68125.50 = PostgreSQL 68125.50; commission 7569.5 | PASS |
| FT-31 | Existing paid orders were back-filled into the ledger | Every paid order has settlements | 0 paid orders are missing a settlement row | PASS |
| FT-32 | Admin dashboard "Orders per customer" chart data | Top 10 customers, highest first | 10 bars, sorted descending, e.g. "Rohan Gaikwad" = 9 | PASS |
| FT-33 | Restaurant dashboard chart is limited to that restaurant | Counts only this restaurant's orders | 7 bars for "Blue Nile" equal the PostgreSQL GROUP BY result; customer token -> 403 | PASS |
| FT-34 | Both dashboards render the bar chart | barChart() used on admin and restaurant dashboards | admin.html and owner.html call barChart(); gradient bar CSS present in style.css | PASS |

## Non-functional Test Cases (performance, security, reliability, integrity, usability)

| Test ID | Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| NFT-01 | Performance: restaurant list response time | Median < 300 ms | median 3 ms, max 17 ms (15 requests) | PASS |
| NFT-02 | Performance: admin dashboard queries (JOIN/aggregate) | Median < 400 ms | 3 dashboard calls: median 7 ms, max 11 ms | PASS |
| NFT-03 | Performance: place an order | Median < 800 ms | median 6 ms, max 15 ms (5 orders) | PASS |
| NFT-04 | Load: 60 concurrent requests | All succeed; 95th percentile < 2 s | 60/60 returned 200; p95 211 ms, max 219 ms | PASS |
| NFT-05 | Scalability: 150 sequential requests, no errors / leaks | All 200 | 150/150 requests answered with HTTP 200 | PASS |
| NFT-06 | Security: passwords stored hashed, never returned | bcrypt hash in DB; no password_hash in any response | Stored as $2a$10$… (bcrypt); login, activity and order responses contain no password field | PASS |
| NFT-07 | Security: forged / tampered / expired tokens | All rejected with 401 | tampered/expired/forged/garbage/missing -> 401, 401, 401, 401, 401; valid token -> 200 | PASS |
| NFT-08 | Security: role-based access (privilege escalation) | Wrong role gets 403 | 7 forbidden combinations -> 403,403,403,403,403,403,403; another customer cannot open order #55 (404) | PASS |
| NFT-09 | Security: brute-force login protection | Locked after 8 failed attempts (429) | Attempts 1-8 -> 401, attempt 9+ -> 429 (401,401,401,401,401,401,401,401,429,429) | PASS |
| NFT-10 | Security: response headers | nosniff, X-Frame-Options, Referrer-Policy present | X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy: no-referrer | PASS |
| NFT-11 | Reliability: malformed JSON never crashes the server | JSON error, server alive | HTTP 400 JSON "Invalid JSON in request"; /health still 200 | PASS |
| NFT-12 | Reliability / concurrency: 20 parallel signups with the same email | Exactly one succeeds, others 409 | 1 x HTTP 200 and 19 x HTTP 409; PostgreSQL UNIQUE constraint held under race | PASS |
| NFT-13 | Data integrity / concurrency: 10 parallel payments for one order | Exactly one payment succeeds; one settlement set | 1 x 200, 9 x 409 ("Already paid"); 2 settlements (no duplicates) | PASS |
| NFT-14 | Data integrity: every order total = items + delivery fee; no orphan rows | No inconsistent rows | 0 orders with wrong total, 0 orphan sub-orders, 0 orphan settlements, 0 orders whose subtotal differs from its sub-orders | PASS |
| NFT-15 | Maintainability: upgrade script is idempotent | Running v2_upgrade.sql again causes no error and no data loss | Re-ran database/v2_upgrade.sql: no error; settlements 78, users 36 unchanged | PASS |
| NFT-16 | Usability / compatibility: every page is responsive and titled | viewport meta, <title>, labelled login fields | 8 pages have viewport + title; login uses labels, masked password field and live password checklist | PASS |
| NFT-17 | Recoverability: server restarts cleanly after a crash/stop | Healthy again | Restarted: /health -> 200, database connected | PASS |
