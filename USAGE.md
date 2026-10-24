# Using the board

Sign in at `/login` with the demo account printed on the card
(`cenius@cenius.ai` / `cenius`) or press **Use demo account** to fill the fields.

The left rail is the only navigation: **Allocation board**, **Depot sidings**,
**Pantograph notices**, with the signed-in name and role pinned to the bottom next to
**Sign out**. On narrow screens the rail collapses into a compact bar above the
workspace.

## Allocation board (`/`)

1. Choose a **service date** (defaults to today) and a **shift** — Early (05:00–13:00),
   Late (13:00–21:00) or Night (21:00–05:00). Both reload the board.
2. The counters above the records read *cars allocated*, *cars unallocated* (of the
   10-car fleet) and *open notices*.
3. Each record shows the route code and name, the tram car's fleet number, the siding
   slot the car stands on, and a severity badge when that car has an open pantograph
   notice.
4. **New allocation** opens a form pre-filled with the shift and date you are looking
   at. Pick a route and a car, add an optional note (200 characters) and save. A car
   cannot be put on the same route, shift and date twice — the form says so next to
   the car field.
5. **Edit** reopens the same form for that record; **Delete** asks for confirmation
   before removing it. Both write straight to `data/db.json`, so the change survives a
   reload and a server restart.

## Depot sidings (`/depot`)

Slots are grouped by track (A, B, C). Each row is one slot:

- occupied → fleet number, class, status chip (in-service / standby / maintenance) and
  the car's current pantograph reading in millimetres, plus **Release slot**;
- empty → **Empty** and an **Assign car** select listing the cars that are not parked
  anywhere. A slot holds one car and a car holds one slot; if you pick a slot that is
  already taken the server answers `Slot A1 is occupied by car 101` inline on that row
  and the rest of the depot stays usable.

## Pantograph notices (`/notices`)

The raise form sits beside the newest-first notice list.

1. Pick the car — the wear field pre-fills with that car's current reading.
2. Choose the severity: **Minor**, **Major** or **Critical**.
3. Enter the wear reading in millimetres. Values outside 0–60 are rejected with
   `Wear reading must be between 0 and 60 mm` next to the field, and everything you
   typed is kept so you can correct it.
4. Add an optional note and press **Raise notice**. The new notice appears at the top
   with its badge, a green confirmation names the car, and the car's reading is
   updated everywhere (board and depot view) because the latest inspection wins.

## Session behaviour

The session is an `HttpOnly` cookie backed by an in-memory map. A browser refresh
calls `GET /api/session` before anything else renders, so you stay signed in on any of
the three screens; restarting the server signs everyone out. Opening `/`, `/depot` or
`/notices` while signed out lands on `/login` and returns you to the page you asked
for after signing in. No write control is rendered while signed out — the API answers
`401 {"error":"Not signed in"}` if one is called directly.
