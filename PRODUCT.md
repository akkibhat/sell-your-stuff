# Product


## Platform

web

## Users

- **Buyers (primary).** Friends, neighbours and locals who open a sale link someone shared with them, mostly on a phone. They browse what's left, look at photos and price, and send an offer without making an account.
- **Sellers.** People clearing out their stuff because they're moving or decluttering. In hosted mode they're friends of the site owner who join with an invite code; in template mode they deploy their own copy. They list items, pick winning offers and track who's paid and picked up.
- **Site owner (hosted mode).** Runs one site for a few friends: makes invite codes, sees every sale, pauses or deletes one.

## Product Purpose

One page for a whole sale, so a seller can send everyone to the same place instead of juggling Marketplace, Trade Me and hundreds of messages. Success is a buyer finding something, seeing it's still available and making an offer in a minute, and a seller always knowing where each item stands.

## Positioning

A sale site you run yourself. It was built for a real moving sale (move.pi.co.nz) and then opened up for friends. No marketplace, no fees, no buyer accounts, and the listing updates live as items sell.

## Operating Context

- Links get shared in group chats, texts and social posts, then opened on phones.
- Sales are short-lived: days to a few weeks, then closed.
- Offers also arrive by text or in person, and sellers log them in admin.
- Pickup is in person, from a suburb or town the seller names.

## Capabilities and Constraints

- Two modes from one codebase: template (one sale, one admin password) and hosted (many invited sellers at `site/their-sale`, live at sell.pi.co.nz).
- Pages: hosted home, sign-up, owner (invites and sellers), seller/admin (items, offers, settings), public sale page with filters and an item dialog with an offer form.
- Item statuses include Draft, Available and sold-style states; filters show counts.
- Sellers set their sale name, intro, pickup area, currency and an accent colour, and can close the sale.
- Cloudflare Worker serving static `public/` pages. Strict CSP: no inline styles or scripts, no external hosts. Pages build content from text nodes.
- Photos are resized in the browser before upload, which strips location data.
- Free plan friendly: no paid services required (R2 in hosted mode needs a card on file).

## Brand Commitments

- Name: Sell Your Stuff.
- Logo: an open cardboard moving box with a green price tag (`public/favicon.svg`, tag green #2f6f5e). Keep it.
- Voice: plain, friendly New Zealand English. Contractions, short sentences, no jargon.

## Evidence on Hand

- Sample sale photos used in the portfolio (Wikimedia Commons, CC0 and public domain) under the portfolio repo's `library/img/sell-your-stuff/`.
- No testimonials, user counts or press. Don't invent any.

## Product Principles

1. The buyer on a phone comes first: what's available, what it costs, how to offer.
2. The seller's own sale is the star. The app's branding stays in the background.
3. One place for everything, kept current, with no redeploys.
4. Respect privacy: suburb not street, no buyer accounts, stripped photo data.
5. Simple enough for a friend who's never run a website.
