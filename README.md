# Sell Your Stuff

A simple sale site you run yourself. Handy when you're moving, clearing out the
garage or just have too much stuff.

- List items with photos, prices and a condition note
- Buyers send offers from the page, no account needed
- Pick a winner, then track who's paid and who's picked up
- Add, edit and remove items from an admin page. No code, no redeploys
- Runs on Cloudflare's free plan, with no card needed

It comes in two flavours from the same code:

- **Template mode** (the default): one sale, just for you. This is what the
  Deploy button sets up.
- **Hosted mode**: one site with lots of sellers, each with their own sale at
  `your-site/their-sale`. Sellers join with an invite code you hand out.

## Set it up (template mode)

1. Make a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
2. Click the button below and follow the steps.
3. When it asks for `ADMIN_PASSWORD`, choose a long password. You'll use it to sign in.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/akkibhat/sell-your-stuff)

Cloudflare makes a small database and a photo store for you, and sets up the
tables on the first deploy.

When it's done you get an address like `sell-your-stuff.your-name.workers.dev`.
That's your sale page. Add `/admin` to the end to sign in and start listing.

## Using it

- **Items:** add an item, drop in up to 8 photos and set a price. Use 0 for free
  stuff. Set the status to Draft to hide an item until it's ready.
- **Offers:** offers from the page land here. You can also add ones you get by
  text or in person. Pick a winner, then mark it paid and picked up.
- **Settings:** your sale name, intro, pickup area, currency and colour. Close
  the sale here when you're done.

## Good to know

- Photos are shrunk in your browser before they upload. That also strips the
  location data phones hide in photos.
- Put a suburb or town as your pickup location, not your street address.
- A photo you delete can stay visible for up to a day while caches catch up.
- Buyers give you their name and email. Look after them and delete the site
  when your sale is over.

## Email alerts (optional)

Offers always show up in the admin page. If you'd also like an email for each
one, make a [Resend](https://resend.com) account and add these secrets to your
Worker in the Cloudflare dashboard:

- `RESEND_API_KEY`: your Resend API key
- `SENDER_EMAIL`: an address on a domain you've verified with Resend
- `NOTIFY_EMAIL`: where the alerts should go (template mode only)

In hosted mode each seller's alerts go to the email they signed up with, so
there's no `NOTIFY_EMAIL`. Resend's free plan sends 100 emails a day, shared
by every seller on the site.

## Hosted mode

Hosted mode is for running one site for a few friends. Here's how it works:

- The home page says what the site is, with a sign-up link and a seller sign-in.
  It never lists anyone's sales.
- You sign in at `/owner` with `OWNER_PASSWORD`. From there you make invite
  codes, see every seller and their sale link, and pause or delete a sale.
- Each invite code works once. You see the full code when you make it, so share
  or copy it then. After that only the first four letters show.
- **Share invite** opens your phone's share sheet (Instagram, Messages and so
  on) with a sign-up link that fills in the code. On a computer it copies the
  link instead.
- A friend signs up at `/signup` with the code, their email, a password and the
  name and link for their sale, like `/sams-moving-sale`. Links use lowercase
  letters, numbers and hyphens, 3 to 40 characters.
- Sellers sign in at `/admin` with their email and password. Each seller only
  ever sees and changes their own sale.
- A paused sale disappears from the site and its seller can't sign in until
  you unpause it. Deleting a sale removes the seller, their items, offers and
  photos for good.

Hosted mode keeps photos in R2, which needs a card on your Cloudflare account
(10 GB is free). Everything else is in D1, which doesn't.

### Deploy hosted mode

You'll need Wrangler signed in to your Cloudflare account (`npx wrangler login`).

1. Make the database and copy the id it prints:
   ```
   npx wrangler d1 create sell-your-stuff-hosted
   ```
   Paste the id into `wrangler.toml` under `[[env.hosted.d1_databases]]` as
   `database_id = "..."`.
2. Make the photo bucket:
   ```
   npx wrangler r2 bucket create sell-your-stuff-photos
   ```
3. Add the secrets:
   ```
   npx wrangler secret put OWNER_PASSWORD --env hosted
   npx wrangler secret put SESSION_SECRET --env hosted
   ```
   `SESSION_SECRET` signs everyone's sign-in cookies. Make it long and random.
   Changing it signs everybody out. Add `RESEND_API_KEY` and `SENDER_EMAIL` the
   same way if you want offer emails.
4. Point it at your domain. In `wrangler.toml`, uncomment the `routes` line
   under `[env.hosted]` and put your domain in. The domain needs to be on the
   same Cloudflare account.
5. Set up the tables and deploy:
   ```
   npm run deploy:hosted
   ```
6. Go to `/owner`, sign in and make your first invite.

## Run it on your own computer

Template mode:

```
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Then open http://localhost:8791/admin and sign in with the password from `.dev.vars`.

Hosted mode reads its secrets from `.dev.vars.hosted` instead. Put
`OWNER_PASSWORD` and `SESSION_SECRET` in there, then run `npm run dev:hosted`
and open http://localhost:8792/owner.

Both `dev` commands set up the local tables first, so they're safe to run again.

## Free plan limits worth knowing

Everything here fits Cloudflare's free plan for a handful of sales. The ones you
might bump into on a busy day:

- Workers: 100,000 requests a day.
- D1: 5 million rows read and 100,000 rows written a day. Every offer, item
  change and sign-in attempt writes a row or two.
- KV (template photos only): 1,000 writes a day, so about 1,000 photo uploads.
- Passwords are hashed with PBKDF2 at 10,000 rounds. That's lighter than ideal,
  but the free plan only allows 10 ms of work per request. The count is stored
  with each password, so it can go up later.
