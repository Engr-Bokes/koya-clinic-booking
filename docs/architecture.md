# CareSlot: design notes

This is an assessment demonstration, not a production clinical system. Use fictional patient information.

## Why Node.js, Express, and PostgreSQL?

Node.js and Express keep the HTTP layer straightforward. PostgreSQL keeps bookings durable across requests and serverless restarts. The backend follows the supplied OpenAPI contract rather than inventing its own response shape.

## The most important correctness decision

Availability shown in the page is only a snapshot. Two users can see an available slot before either submits. The database, not the page, must arbitrate who gets it. A partial unique index on confirmed bookings prevents two active bookings for one slot, even across separate server instances. Cancellation releases that uniqueness condition without deleting the booking history.

## Retry safety versus a genuinely new booking

A client-generated Idempotency-Key identifies one booking attempt. Replaying it must recover the original status and response, while using it for different request data must fail. The demo retains an attempt key after a network failure so a retry cannot accidentally create a duplicate. Authentication keys, database connection details, and patient information must never be committed to GitHub.

## What to verify before submission

- Missing and wrong API keys return 401.
- Slots sort chronologically, with exact provider filtering.
- Booking validates and normalizes name/email and rejects past/unknown slots.
- Multiple simultaneous requests for one slot produce exactly one confirmed booking.
- Cancelling a booking returns cancelled and makes the slot bookable again.
- Same-key same-body retries preserve the original result; changed-body key reuse returns 422.
- Cursor pagination is stable, case-insensitive by email, and ends with a null cursor.
- Each email has its own five-attempt rolling minute limit, including failures; 429 includes integer Retry-After.
- The deployed API uses a persistent database, not process memory.
- The live page can book and show a confirmation.

## Scope limitations to be clear about

The assessment specifies a single shared API key. That is not an appropriate end-user authentication model for real health records. A real deployment would require individual authentication, authorization, audit trails, monitoring, stronger abuse prevention, and data-retention policies. Do not use real patient data in the assessment demo.
