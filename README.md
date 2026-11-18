# Sell Your Stuff

A simple sale site you run yourself. Handy when you're moving, clearing out the
garage or just have too much stuff.

- List items with photos, prices and a condition note
- Buyers send offers from the page, no account needed
- Pick a winner, then track who's paid and who's picked up
- Add, edit and remove items from an admin page. No code, no redeploys
- Runs on Cloudflare's free plan, with no card needed

## Set it up

1. Make a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
2. Click the button below and follow the steps.
3. When it asks for `ADMIN_PASSWORD`, choose a long password. You'll use it to sign in.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/akkibhat/sell-your-stuff)

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
- Changes can take up to a minute to show for every visitor.
- Buyers give you their name and email. Look after them and delete the site
  when your sale is over.

## Email alerts (optional)

Offers always show up in the admin page. If you'd also like an email for each
one, make a [Resend](https://resend.com) account and add these three secrets
to your Worker in the Cloudflare dashboard:

- `RESEND_API_KEY`: your Resend API key
- `SENDER_EMAIL`: an address on a domain you've verified with Resend
- `NOTIFY_EMAIL`: where the alerts should go

## Run it on your own computer

```
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Then open http://localhost:8791/admin and sign in with the password from `.dev.vars`.
