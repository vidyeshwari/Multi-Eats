# MultiEats — Software Testing (sections 19–22 of the project report)

The project runs on **PostgreSQL** (the college sheet says MySQL; every "MySQL" test is executed on PostgreSQL).

## How the evidence is produced
| What | How | Screenshot to take |
|---|---|---|
| ST-01 … ST-20 (Standard), ET-01 … ET-21 (Edge), FT-01 … FT-34 (Functional), NFT-01 … NFT-17 (Non-functional) | Automated: from the `backend` folder run `npm test` (needs the **local** PostgreSQL; it refuses to touch a cloud `DATABASE_URL`). It starts the real server, runs every test and writes **`TEST_REPORT.md`** with the real *Actual Result* and *Status* of each test. | 1) the terminal showing the green PASS lines and `NN / NN passed`; 2) `TEST_REPORT.md` opened in VS Code preview (one screenshot per table) |
| MT-01 … MT-05 (Manual) | By hand in the browser + pgAdmin, steps below | 3 screenshots per MT: before, webpage result, pgAdmin SELECT |
| New-feature manual checks MT-06 … MT-12 | By hand in the browser, steps below | the error message / screen named in each step |

`TEST_REPORT.md` shipped in the zip is a sample from a run on the developer machine. **Run `npm test` on your own laptop and use *that* output for your screenshots.** Each screenshot should include the date/time (taskbar) and, for database proof, the pgAdmin query *and* its result.

Test data created by `npm test` is prefixed `zz_` and removed automatically.

## 22. Manual test cases (simulate a real user)
Use the local app (`npm start` in `backend`, open http://localhost:5000). Demo logins are printed by `npm run setup-db`.
Run `node seed-orders.js 20` once so there is data to look at.

### MT-01 – Login
1. Open the app → **Login**. 2. Email `restaurants@multieats.test`, password `Rest@urant#Panel9` (shared restaurant login). 3. Click **Login**. 4. The restaurant panel opens and asks you to select a restaurant.
Database check: `SELECT user_id, name, email, role, can_switch_restaurant FROM users WHERE email='restaurants@multieats.test';`

### MT-02 – Add record (menu item)
1. Login (MT-01), select a restaurant. 2. Open the **📖 Menu** tab, use the **➕ Add menu item** form (name, price). 3. Click add → success message. 4. The item is on the page. 5. Database check: `SELECT * FROM menuitems WHERE name = '<item name>';` (restaurant_id must be the selected restaurant).

### MT-03 – Search / view
1. Home page → type a cuisine/restaurant name in the search box. 2. Result list appears. 3. Compare: `SELECT restaurant_id, name, cuisine_type FROM restaurants WHERE name ILIKE '%<text>%' OR cuisine_type ILIKE '%<text>%';`

### MT-04 – Update record
1. Restaurant panel → **📖 Menu**; the table cells are editable: change the **Price ₹** box of an item and click outside the box (it saves automatically). 2. Reload the tab: the new price is shown. 3. `SELECT item_id, name, price FROM menuitems WHERE item_id = <id>;`

### MT-05 – Delete record
1. Restaurant panel → **📖 Menu** → click **Delete** on an item → confirm. 2. Item disappears. 3. `SELECT * FROM menuitems WHERE item_id = <id>;` → 0 rows.

### New-feature manual checks
| ID | Steps | Expected (screenshot this) |
|---|---|---|
| MT-06 | Login page → **Create account** (sign-up form); enter phone `6123456789` (valid email, strong password) → Sign up | Red message "Phone number must be exactly 10 digits and start with 7, 8 or 9"; no login. `SELECT * FROM users WHERE email='<email>';` → 0 rows |
| MT-07 | Same page, phone `9876543210`, password `password` | Red message "Password is too weak. It needs: …"; no login. Typing a password shows the live ✓/✗ checklist |
| MT-08 | Sign up with phone `9876543210` and password `Tr!ckyP4ss#Word` | Account created and logged in; `SELECT name,email,phone FROM users ORDER BY user_id DESC LIMIT 1;` |
| MT-09 | Login as `restaurants@multieats.test`; choose **restaurant A** in the dropdown, open Orders; then choose **restaurant B** | Only A's data, then only B's data. One login, no other accounts needed |
| MT-10 | Dashboards: main admin (`restaurant@multieats.test` / `restaurant123`) and restaurant panel | Gradient bar chart "Orders per customer" on both (admin = all customers, restaurant = only its customers). Compare with `SELECT u.name, COUNT(*) FROM orders o JOIN users u USING(user_id) GROUP BY u.name ORDER BY 2 DESC LIMIT 10;` |
| MT-11 | Customer places a multi-restaurant order and clicks **Simulate payment**. Admin → **Settlements** | Note "payment is held by MultiEats"; one row per restaurant with status `held`. `SELECT * FROM settlements WHERE order_id=<id>;` |
| MT-12 | Restaurant marks its part delivered → admin **Settlements** → **Release payout** → restaurant **Payouts** → **Received** | Status goes held → payable → paid → confirmed. Try **Not received** on another row → status `disputed` and the admin sees the note |
