'use strict';
const express = require('express');
const { createApp } = require('./app');

const apiDescription = {
  name: 'CareSlot Clinic Booking API',
  version: '1.0.0',
  base_path: '/api',
  documentation: '/docs',
  openapi: '/docs/openapi.json',
  frontend: '/',
  authentication: { type: 'apiKey', header: 'X-API-Key', required_for: 'All booking API endpoints', example: 'YOUR_API_KEY' },
  endpoints: [
    { method: 'GET', path: '/api/slots', description: 'List slots and availability; optionally filter by exact provider name.' },
    { method: 'POST', path: '/api/bookings', description: 'Book a future slot; supports Idempotency-Key.' },
    { method: 'GET', path: '/api/bookings', description: 'List bookings by email with cursor pagination.' },
    { method: 'GET', path: '/api/bookings/{id}', description: 'Look up a booking.' },
    { method: 'DELETE', path: '/api/bookings/{id}', description: 'Cancel a confirmed booking and release its slot.' },
    { method: 'POST', path: '/api/reset', description: 'Evaluator/test use: replaces all slots and deletes bookings and request bookkeeping.' }
  ],
  notice: 'Assessment demo. Use fictional patient details. Request the private API key from the assessment owner; no real key is published here.',
  compatibility: 'Original unprefixed booking endpoints remain supported. Prefer /api for new clients.'
};

function createHttpApp(options) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api', (req, res) => res.json(apiDescription));
  const bookingApi = createApp(options);
  app.use('/api', bookingApi);
  app.use(bookingApi); // Preserve the original contract routes for existing clients.
  return app;
}
module.exports = { createHttpApp, apiDescription };
