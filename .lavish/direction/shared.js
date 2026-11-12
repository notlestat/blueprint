// Fills every [data-ab] element with the same mock artboard content.
const AB = {
  pricing: `<div class="m"><div class="m-nav"><span class="m-logo">Tidewater</span><span class="m-links"><span>Rooms</span><span>Pricing</span><span>Sign in</span></span></div>
  <div class="m-hero"><h1>Book the room, not the admin.</h1><p>Studio booking for rehearsal spaces. Calendars, deposits and door codes in one place.</p></div>
  <div class="m-plans">
   <div class="m-plan"><b>Solo</b><div class="p">£0</div><ul><li>1 room</li><li>20 bookings a month</li></ul><span class="m-btn ghost">Start</span></div>
   <div class="m-plan"><b>Studio</b><div class="p">£24</div><ul><li>5 rooms</li><li>Deposits and door codes</li></ul><span class="m-btn" data-target="cta">Start free trial</span></div>
   <div class="m-plan"><b>Complex</b><div class="p">£79</div><ul><li>Unlimited rooms</li><li>Staff roles</li></ul><span class="m-btn ghost">Talk to us</span></div>
  </div></div>`,
  signin: `<div class="m"><div class="m-phone"><h2>Welcome back</h2><p>Sign in to manage your rooms.</p><span class="m-field">Email</span><span class="m-field">Password</span><span class="m-btn">Sign in</span><div class="m-small">Forgot your password?</div></div></div>`,
  empty: `<div class="m"><div class="m-empty"><div><svg viewBox="0 0 64 64" fill="none" stroke="#17201b" stroke-width="1.5"><rect x="10" y="14" width="44" height="38" rx="3"/><path d="M10 24h44M22 9v9M42 9v9M24 38h16"/></svg><h3>No sessions this week</h3><p>Bookings show up here as soon as someone reserves a room.</p><span class="m-btn">Share your booking link</span></div></div></div>`
};
document.querySelectorAll('[data-ab]').forEach(el => { el.innerHTML = AB[el.dataset.ab]; });
