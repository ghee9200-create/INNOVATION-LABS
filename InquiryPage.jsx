import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { isInquiryDateBookable } from './inquiryBookingRules.js';

const request = async (url, options = {}) => {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let result = null;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) throw new Error(result?.message || `Request failed (${response.status}).`);
  return result;
};

const formatDate = (dateKey, timezone) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
};
const formatTime = (date, timezone) => new Intl.DateTimeFormat('en-IN', {
  timeZone: timezone, hour: 'numeric', minute: '2-digit',
}).format(new Date(date));
const bookingStatusLabel = (booking) => booking?.status || 'Upcoming';
const tokenStatusLabel = (booking) => booking?.tokenStatus === 'active' ? 'Active Token'
  : booking?.tokenStatus === 'completed' ? 'Token Completed'
    : booking?.token ? 'Token Generated' : 'Awaiting Token';
const maskedPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 4 ? `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}` : '••••';
};

export function InquiryPage({ auth, onSignIn }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSection = ['booking', 'booked', 'start'].includes(searchParams.get('section'))
    ? searchParams.get('section') : 'booking';
  const [customerName, setCustomerName] = useState(auth?.name || '');
  const [customerEmail, setCustomerEmail] = useState(auth?.email || '');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState('');
  const [availability, setAvailability] = useState(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [foundBookings, setFoundBookings] = useState([]);
  const [selectedLookup, setSelectedLookup] = useState('');
  const [verifiedBooking, setVerifiedBooking] = useState(null);
  const [verifiedBookings, setVerifiedBookings] = useState([]);
  const [selectedVerifiedId, setSelectedVerifiedId] = useState('');
  const [verifiedTimezone, setVerifiedTimezone] = useState('Asia/Kolkata');
  const [serverTimeOffset, setServerTimeOffset] = useState(0);
  const [sessionNow, setSessionNow] = useState(Date.now());
  const [savedBooking, setSavedBooking] = useState(null);
  const [generatedTokenBooking, setGeneratedTokenBooking] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bookingStep, setBookingStep] = useState(0);
  const uniqueFoundBookings = [...new Map(foundBookings.map((booking) => [booking.id, booking])).values()];
  const dateIsBookable = (date) => Boolean(
    date?.available
      && availability?.today
      && isInquiryDateBookable(date.dateKey, availability.today, availability.subscriptionPlan),
  );
  useEffect(() => {
    setCustomerName((current) => current || auth?.name || '');
    setCustomerEmail((current) => current || auth?.email || '');
  }, [auth?.name, auth?.email]);
  useEffect(() => {
    if (location.state?.sessionEnded) setNotice('Your support session has ended.');
  }, [location.state]);
  const loadAvailability = useCallback(async () => {
    const result = await request('/api/inquiries/availability');
    setAvailability(result);
    setSelectedDate((current) => {
      const currentDate = result.dates.find((date) => date.dateKey === current);
      return currentDate?.available && currentDate.slots.length
        ? current
        : result.dates.find((date) => date.available && date.slots.length)?.dateKey || '';
    });
    setSelectedSlot(null);
  }, [auth?.email, auth?.googleId, auth?.name]);

  useEffect(() => {
    loadAvailability().catch((loadError) => setError(loadError.message));
  }, [loadAvailability]);

  useEffect(() => {
    if (bookingStep !== 2) return undefined;
    const refresh = () => loadAvailability().catch((loadError) => setError(loadError.message));
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [bookingStep, loadAvailability]);

  useEffect(() => {
    const interval = window.setInterval(() => setSessionNow(Date.now() + serverTimeOffset), 1000);
    return () => window.clearInterval(interval);
  }, [serverTimeOffset]);

  const inquirySessionState = verifiedBooking
    ? ['Completed', 'Cancelled', 'Expired'].includes(verifiedBooking.status) ? 'ended'
      : sessionNow < new Date(verifiedBooking.slotStart).getTime() ? 'scheduled'
      : sessionNow < new Date(verifiedBooking.slotEnd).getTime() ? 'active' : 'ended'
    : '';
  useEffect(() => {
    if (!verifiedBooking?.id || inquirySessionState !== 'active'
      || verifiedBooking.status === 'In Progress') return undefined;
    let active = true;
    const refresh = () => request(`/api/inquiries/${verifiedBooking.id}/messages`)
      .then((result) => { if (active) setVerifiedBooking(result.booking); })
      .catch((loadError) => { if (active) setError(loadError.message); });
    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(interval); };
  }, [verifiedBooking?.id, verifiedBooking?.status, inquirySessionState]);

  const changeSection = (section) => {
    setError('');
    setNotice('');
    setSearchParams(section === 'booking' ? {} : { section });
  };
  const startBooking = () => {
    if (!auth) {
      onSignIn();
      return;
    }
    if (!customerName.trim() || customerName.trim().length > 120) {
      setError('Enter your full name (up to 120 characters).');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim()) || customerEmail.trim().length > 254) {
      setError('Enter a valid email address.');
      return;
    }
    if (!/^[+()\d\s-]{7,20}$/.test(phone.trim()) || phone.replace(/\D/g, '').length < 10 || phone.replace(/\D/g, '').length > 15) {
      setError('Enter a valid phone number before saving your booking.');
      return;
    }
    setError('');
    setNotice('');
    setSavedBooking(null);
    setBookingStep(1);
  };
  const chooseCategory = (value) => setCategory(value);
  const proceedToSlots = async () => {
    if (!category) {
      setError('Choose Problem or General Inquiry to continue.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await loadAvailability();
      setBookingStep(2);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };
  const placeBooking = async () => {
    if (!auth) {
      onSignIn();
      return;
    }
    const selectedDateRecord = availability?.dates.find((date) => date.dateKey === selectedDate);
    if (!selectedDateRecord || !dateIsBookable(selectedDateRecord)) {
      setError('That booking date is no longer available. Refresh availability and choose another date.');
      return;
    }
    if (!customerName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())
      || !selectedSlot || !selectedDate || !/^[+()\d\s-]{7,20}$/.test(phone.trim())
      || phone.replace(/\D/g, '').length < 10 || phone.replace(/\D/g, '').length > 15) {
      setError('Enter a valid name, email, phone number, and select an available time.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await request('/api/inquiries/bookings', {
        method: 'POST',
        body: JSON.stringify({
          customerName: customerName.trim(),
          customerEmail: customerEmail.trim(),
          category,
          phoneNumber: phone,
          dateKey: selectedDate,
          slotStart: selectedSlot.start,
        }),
      });
      setSavedBooking(result.booking);
      setBookingStep(0);
      loadAvailability().catch((loadError) => setError(loadError.message));
    } catch (bookingError) {
      setError(bookingError.message);
      loadAvailability().catch((loadError) => setError(loadError.message));
    } finally {
      setLoading(false);
    }
  };
  const lookupBookings = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    setNotice('');
    setFoundBookings([]);
    setSelectedLookup('');
    setGeneratedTokenBooking(null);
    try {
      const result = await request('/api/inquiries/bookings/lookup', {
        method: 'POST', body: JSON.stringify({ phoneNumber: phone }),
      });
      setFoundBookings(result.bookings);
      setGeneratedTokenBooking(null);
    } catch (lookupError) {
      setError(lookupError.message);
    } finally {
      setLoading(false);
    }
  };
  const verifyToken = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const token = form.elements.token.value;
    const password = form.elements.password.value;
    setLoading(true);
    setError('');
    setVerifiedBooking(null);
    setVerifiedBookings([]);
    setSelectedVerifiedId('');
    try {
      const result = await request('/api/inquiries/bookings/verify-token', {
        method: 'POST', body: JSON.stringify({ token, password }),
      });
      setVerifiedBookings(result.bookings);
      setVerifiedTimezone(result.timezone || availability?.timezone || 'Asia/Kolkata');
      setServerTimeOffset(new Date(result.serverTime).getTime() - Date.now());
      setSessionNow(new Date(result.serverTime).getTime());
      if (result.bookings.length === 1) setVerifiedBooking(result.bookings[0]);
      if (result.bookings.length === 1) setSelectedVerifiedId(result.bookings[0].id);
    } catch (verifyError) {
      setError(verifyError.message);
    } finally {
      setLoading(false);
    }
  };
  const generateToken = async () => {
    const selected = foundBookings.find((item) => item.id === selectedLookup);
    if (!selected) {
      setError('Select a booking before generating its token.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await request(`/api/inquiries/bookings/${encodeURIComponent(selected.id)}/generate-token`, {
        method: 'POST',
        body: '{}',
      });
      setFoundBookings((current) => current.map((item) => item.id === result.booking.id
        ? { ...result.booking, canGenerateToken: false, tokenBlockedReason: 'This booking already has a token.' }
        : item.token ? item : { ...item, canGenerateToken: false, tokenBlockedReason: 'You already have an active token for another booking.' }));
      setGeneratedTokenBooking({ ...result.booking, tokenWasExisting: result.duplicate });
    } catch (tokenError) {
      setError(tokenError.message);
    } finally {
      setLoading(false);
    }
  };
  const proceedVerifiedBooking = () => {
    const result = verifiedBookings.find((item) => item.id === selectedVerifiedId);
    if (!result) {
      setError('Select the booking date that matches your token.');
      return;
    }
    setVerifiedBooking(result);
    setError('');
  };
  const closeBookingDialog = () => {
    setBookingStep(0);
    setError('');
    setSelectedSlot(null);
  };

  return <main className="page-shell inquiry-page">
    <div className="container inquiry-layout">
      <aside className="inquiry-sidebar">
        <span className="eyebrow">INNOVATION LABS SUPPORT</span>
        <h1>Inquiry desk</h1>
        <p>Book a focused session with our team, check your token, or continue an existing enquiry.</p>
        <nav aria-label="Inquiry services">
          {[['booking', 'Inquiry Booking'], ['booked', 'Token'], ['start', 'Start Enquiry']].map(([section, label]) =>
            <button type="button" className={section === activeSection ? 'inquiry-nav-item active' : 'inquiry-nav-item'}
              key={section} onClick={() => changeSection(section)}>{label}<span aria-hidden="true">→</span></button>)}
        </nav>
        {!auth && <div className="inquiry-signin-note"><strong>Sign in to book</strong><span>Your booking details stay linked to your account.</span><button type="button" className="secondary-btn small" onClick={onSignIn}>Sign in</button></div>}
      </aside>

      <section className="inquiry-content">
        {error && <div className="alert-box" role="alert">{error}</div>}
        {notice && <div className="inquiry-success-banner" role="status">{notice}</div>}

        {activeSection === 'booking' && <>
          <div className="inquiry-heading"><span className="eyebrow">01 / RESERVE A SLOT</span><h2>Inquiry Booking</h2><p>Choose a category and available slot to save your booking. Token generation is a separate step on the Token page.</p></div>
          <div className="inquiry-card">
            <div className="inquiry-profile-row"><span className="inquiry-profile-icon" aria-hidden="true">◉</span><div><strong>{auth?.name || 'Sign in to continue'}</strong><span>{auth?.email || 'Your registered account details appear here.'}</span></div></div>
            <label className="inquiry-field">Full Name<input type="text" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Enter your full name" autoComplete="name" maxLength={120} required /></label>
            <label className="inquiry-field">Email Address<input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" maxLength={254} required /></label>
            <label className="inquiry-field">Phone Number<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91 98765 43210" autoComplete="tel" required /></label>
            <div className="inquiry-booking-actions"><p>Sessions last 30 minutes. Select a category and time before saving. Your token is generated separately from the Token page.</p><button className="primary-btn" type="button" onClick={startBooking} disabled={loading || !auth}>{auth ? 'Choose category and time' : 'Sign in to book'}</button></div>
          </div>
        </>}

        {activeSection === 'booked' && <>
          <div className="inquiry-heading"><span className="eyebrow">02 / FIND YOUR RESERVATION</span><h2>Token</h2><p>Search with the phone number used for your booking. Sign in to verify that the bookings belong to your account.</p></div>
          <form className="inquiry-card inquiry-lookup-form inquiry-booking-search" onSubmit={lookupBookings}>
            <label className="inquiry-field">Booking phone number<input type="tel" value={phone} onChange={(event) => { setPhone(event.target.value); setFoundBookings([]); setSelectedLookup(''); setGeneratedTokenBooking(null); setError(''); }} placeholder="Enter your registered booking phone" autoComplete="tel" required /></label>
            <button className="primary-btn" disabled={loading || !auth} type="submit">{loading ? <><span className="inquiry-spinner" aria-hidden="true" />Searching…</> : 'Search Booking'}</button>
            {!auth && <p className="muted">Please sign in to look up your own bookings.</p>}
          </form>
          {uniqueFoundBookings.length > 0 && <section className="inquiry-card inquiry-booking-results" aria-labelledby="saved-bookings-heading">
            <header className="inquiry-results-heading"><div><span className="eyebrow">YOUR RESERVATIONS</span><h3 id="saved-bookings-heading">Your Saved Bookings</h3></div><span>{uniqueFoundBookings.length} booking{uniqueFoundBookings.length === 1 ? '' : 's'}</span></header>
            <p className="muted">Select a confirmed booking to view or generate its saved token.</p>
            <div className="inquiry-customer-booking-list">
              {uniqueFoundBookings.map((item) => {
                const hasToken = Boolean(item.token);
                return <label className={`inquiry-customer-booking${selectedLookup === item.id ? ' selected' : ''}`} key={item.id}>
                  <input type="radio" name="booking-lookup" checked={selectedLookup === item.id} onChange={() => { setSelectedLookup(item.id); setGeneratedTokenBooking(null); setError(''); }} />
                  <span className="inquiry-customer-booking-body">
                    <span className="inquiry-customer-booking-top">
                      <strong className={`inquiry-category-pill${item.category === 'Problem' ? ' problem' : ''}`}>{item.category === 'Inquiry' ? 'General Inquiry' : item.category}</strong>
                      <span className={`inquiry-token-status${item.tokenStatus === 'active' ? ' active' : item.tokenStatus === 'completed' ? ' completed' : ''}`}>{tokenStatusLabel(item)}</span>
                    </span>
                    <span className="inquiry-booking-reference"><small>Booking reference</small><strong>{item.bookingReference}</strong></span>
                    <span className="inquiry-booking-time"><small>{formatDate(item.dateKey, availability?.timezone || 'Asia/Kolkata')}</small><strong>{formatTime(item.slotStart, availability?.timezone || 'Asia/Kolkata')} – {formatTime(item.slotEnd, availability?.timezone || 'Asia/Kolkata')}</strong></span>
                    <span className="inquiry-booking-details-grid">
                      <span><small>Name</small><strong>{item.customerName}</strong></span>
                      <span><small>Email</small><strong>{item.customerEmail}</strong></span>
                      <span><small>Phone</small><strong>{maskedPhone(item.phoneNumber)}</strong></span>
                      <span><small>Booking status</small><strong>{bookingStatusLabel(item)}</strong></span>
                    </span>
                    <span className={`inquiry-booking-token${hasToken ? ' issued' : ''}`}><small>Token</small><strong>{item.token || 'Not generated yet'}</strong></span>
                    {hasToken && item.tokenPassword && <span className="inquiry-booking-token issued"><small>Token password</small><strong>{item.tokenPassword}</strong></span>}
                    {!hasToken && item.tokenBlockedReason && <small className="inquiry-token-blocked">{item.tokenBlockedReason}</small>}
                  </span>
                </label>;
              })}
            </div>
            <button className="primary-btn inquiry-generate-token" type="button" onClick={generateToken} disabled={loading || !selectedLookup}>
              {loading ? <><span className="inquiry-spinner" aria-hidden="true" />Generating…</> : 'Generate Token'}
            </button>
          </section>}
        </>}

        {activeSection === 'start' && <>
          <div className="inquiry-heading"><span className="eyebrow">03 / SECURE CONVERSATION</span><h2>Start Enquiry</h2><p>Verify your token against your signed-in account before viewing your conversation.</p></div>
          {!verifiedBooking && <form className="inquiry-card inquiry-lookup-form" onSubmit={verifyToken}>
            <label className="inquiry-field">Booking token<input name="token" inputMode="text" placeholder="Example: 01" autoComplete="off" required /></label>
            <label className="inquiry-field">Token password<input name="password" type="password" inputMode="text" placeholder="4 letters and 4 digits" autoComplete="off" minLength={8} maxLength={8} required /></label>
            <button className="primary-btn" type="submit" disabled={loading || !auth}>{loading ? 'Verifying…' : 'Verify Token'}</button>
            {!auth && <p className="muted">Sign in with the account used to book this session.</p>}
          </form>}
          {!verifiedBooking && verifiedBookings.length > 1 && <div className="inquiry-card inquiry-booking-results">
            <h3>Choose the matching booking date</h3>
            <p className="muted">Daily tokens restart each business day, so select the date printed on your token.</p>
            {verifiedBookings.map((item) => <label className="inquiry-result-option" key={item.id}>
              <input type="radio" name="token-booking" checked={selectedVerifiedId === item.id} onChange={() => setSelectedVerifiedId(item.id)} />
            <span><strong>{item.category} · {item.token}</strong><small>{formatDate(item.dateKey, verifiedTimezone)} · {formatTime(item.slotStart, verifiedTimezone)} · {item.status}</small></span>
            </label>)}
            <button type="button" className="primary-btn" onClick={proceedVerifiedBooking}>Next</button>
          </div>}
          {verifiedBooking && <div className="inquiry-verified">
            <div className="inquiry-card inquiry-verified-card"><span className="eyebrow">BOOKING VERIFIED</span><h3>{verifiedBooking.category} · {verifiedBooking.token}</h3><p>{formatDate(verifiedBooking.dateKey, verifiedTimezone)} at {formatTime(verifiedBooking.slotStart, verifiedTimezone)}</p><p>Status: <strong>{verifiedBooking.status}</strong></p>
              <p className="inquiry-session-status" role="status">{inquirySessionState === 'scheduled'
                ? `Your inquiry messaging opens at ${formatTime(verifiedBooking.slotStart, verifiedTimezone)} on ${formatDate(verifiedBooking.dateKey, verifiedTimezone)}.`
                : inquirySessionState === 'active' ? 'Your inquiry session is now open.' : 'Your inquiry session has ended.'}</p>
              <button className="secondary-btn small" type="button" onClick={() => { setVerifiedBooking(null); setVerifiedBookings([]); setSelectedVerifiedId(''); }}>Use another token</button></div>
            {inquirySessionState === 'active' && verifiedBooking.status === 'In Progress'
              ? <ChatPanel booking={verifiedBooking} role="customer" onBookingChange={setVerifiedBooking} serverNow={sessionNow} />
              : inquirySessionState === 'active' && verifiedBooking.status === 'Ready'
                ? <p className="inquiry-session-status" role="status">Your booking time has started. The chat will open when the administrator activates your valid token.</p>
              : inquirySessionState === 'scheduled'
                ? <ScheduledMessagePanel booking={verifiedBooking} />
                : null}
          </div>}
        </>}
      </section>
    </div>

    {bookingStep > 0 && <div className="inquiry-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeBookingDialog(); }}>
      <section className="inquiry-modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-modal-title">
        <button className="inquiry-modal-close" type="button" aria-label="Close booking dialog" onClick={closeBookingDialog}>×</button>
        {bookingStep === 1 ? <>
          <span className="eyebrow">BOOK A SUPPORT SESSION</span><h2 id="inquiry-modal-title">What can we help with?</h2>
          <div className="inquiry-category-options">{['Problem', 'General Inquiry'].map((value) => <button type="button" key={value} className={category === value ? 'inquiry-category-option selected' : 'inquiry-category-option'} onClick={() => chooseCategory(value)}><strong>{value}</strong><span>{value === 'General Inquiry' ? 'Questions, advice, or product guidance.' : 'Troubleshooting help for a project or build.'}</span></button>)}</div>
          {error && <div className="alert-box" role="alert">{error}</div>}<button type="button" className="primary-btn" onClick={proceedToSlots} disabled={loading}>{loading ? 'Loading slots…' : 'Next'}</button>
        </> : <>
          <span className="eyebrow">SELECT AN AVAILABLE TIME</span><h2 id="inquiry-modal-title">Choose your session</h2>
          <p className="muted">{availability?.timezone ? `Times shown in ${availability.timezone}. ${availability.priorityBooking ? 'Tomorrow is reserved for Exclusive priority booking.' : 'Tomorrow is reserved for active Exclusive subscribers.'}` : 'Loading business hours…'}</p>
          <div className="inquiry-date-list">{availability?.dates.map((date) => { const bookable = dateIsBookable(date); return <section key={date.dateKey} className={`inquiry-date-row${date.dateKey === selectedDate ? ' selected' : ''}${bookable ? '' : ' is-disabled'}${date.priorityBooking ? ' is-priority' : ''}`}>
            <button className="inquiry-date-button" type="button" disabled={!bookable || !date.slots.length} aria-disabled={!bookable} onClick={() => { if (!bookable || !date.slots.length) return; setSelectedDate(date.dateKey); setSelectedSlot(null); }}><strong>{formatDate(date.dateKey, availability.timezone)}</strong><span>{date.slots.length && bookable ? `${date.slots.length} ${date.slots.length === 1 ? 'slot' : 'slots'}` : date.unavailableReason || 'Fully booked'}</span>{date.priorityBooking && <small>Exclusive early access</small>}</button>
            {bookable && date.dateKey === selectedDate && <div className="inquiry-slot-list">{date.slots.map((slot) => <button type="button" key={slot.start} className={selectedSlot?.start === slot.start ? 'inquiry-slot selected' : 'inquiry-slot'} onClick={() => setSelectedSlot(slot)}>{formatTime(slot.start, availability.timezone)}</button>)}</div>}
          </section>; })}</div>
          {availability && !availability.dates.some((date) => date.slots.length) && <div className="empty-state"><h3>No slots are available right now.</h3><p>Please check back later.</p></div>}
          {selectedSlot && <div className="inquiry-confirm-row"><div><strong>{category}</strong><span>{formatDate(selectedDate, availability.timezone)} · {formatTime(selectedSlot.start, availability.timezone)}–{formatTime(selectedSlot.end, availability.timezone)}</span></div><button type="button" className="primary-btn" onClick={placeBooking} disabled={loading} aria-live="polite">{loading && <span className="inquiry-spinner" aria-hidden="true" />}{loading ? 'Saving Booking…' : 'Save Booking'}</button></div>}
          {error && <div className="alert-box" role="alert">{error}</div>}
        </>}
      </section>
    </div>}
    {savedBooking && <div className="inquiry-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSavedBooking(null); }}>
      <section className="inquiry-modal inquiry-booking-saved-modal" role="dialog" aria-modal="true" aria-labelledby="booking-saved-title">
        <button className="inquiry-modal-close" type="button" aria-label="Close booking confirmation" onClick={() => setSavedBooking(null)}>×</button>
        <span className="inquiry-booking-check" aria-hidden="true">✓</span>
        <span className="eyebrow">BOOKING SAVED</span>
        <h2 id="booking-saved-title">Booking Placed Successfully!</h2>
        <p>Your booking has been saved. Visit the Token page to find this booking and generate its token when you are ready.</p>
        <div className="inquiry-saved-reference"><strong>Booking reference</strong><span>{savedBooking.bookingReference}</span></div>
        <div className="inquiry-modal-actions">
          <button type="button" className="primary-btn" onClick={() => { setSavedBooking(null); setSearchParams({ section: 'booked' }); }}>Go to Token Page</button>
          <button type="button" className="secondary-btn" onClick={() => setSavedBooking(null)}>Close</button>
        </div>
      </section>
    </div>}
    {generatedTokenBooking && <div className="inquiry-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setGeneratedTokenBooking(null); }}>
      <section className="inquiry-modal inquiry-booking-saved-modal" role="dialog" aria-modal="true" aria-labelledby="token-generated-title">
        <button className="inquiry-modal-close" type="button" aria-label="Close token confirmation" onClick={() => setGeneratedTokenBooking(null)}>×</button>
        <span className="inquiry-booking-check" aria-hidden="true">✓</span>
        <span className="eyebrow">TOKEN CONFIRMATION</span>
        <h2 id="token-generated-title">{generatedTokenBooking.tokenWasExisting ? 'Your Existing Token' : 'Your Token Has Been Generated!'}</h2>
        <div className="inquiry-saved-reference"><strong>Booking reference</strong><span>{generatedTokenBooking.bookingReference}</span></div>
        <div className="inquiry-ticket-token">{generatedTokenBooking.token}</div>
        {generatedTokenBooking.tokenPassword && <div className="inquiry-saved-reference"><strong>Token password</strong><span>{generatedTokenBooking.tokenPassword}</span></div>}
        <p>{generatedTokenBooking.tokenWasExisting ? 'This booking already has a token. The existing token is shown above.' : 'Your token is ready. Messaging opens only during the scheduled inquiry session.'}</p>
        <div className="inquiry-modal-actions"><button type="button" className="primary-btn" onClick={() => setGeneratedTokenBooking(null)}>Close</button></div>
      </section>
    </div>}
  </main>;
}

function ScheduledMessagePanel({ booking }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [scheduleStatus, setScheduleStatus] = useState(booking.scheduledMessageStatus || 'Not scheduled');
  const canSchedule = ['Upcoming', 'Ready'].includes(booking.status)
    && new Date(booking.slotStart).getTime() > Date.now() && scheduleStatus === 'Not scheduled';
  const send = async () => {
    setLoading(true);
    setError('');
    try {
      await request(`/api/inquiries/${booking.id}/schedule-message`, {
        method: 'POST', body: JSON.stringify({ text }),
      });
      setScheduleStatus('scheduled');
      setText('');
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setLoading(false);
    }
  };
  const expired = ['Completed', 'Cancelled', 'Expired'].includes(booking.status);
  return <div className="inquiry-card inquiry-message-prep">
    <h3>{expired ? 'This session has ended' : 'Prepare a message'}</h3>
    {expired ? <p>This booking is {booking.status.toLowerCase()}. A conversation cannot be started for it.</p>
      : <><p>Before your slot begins, you can schedule one initial message. It will be delivered automatically at the session start.</p>
        <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} placeholder="Write the first message for your support session…" />
        <div className="inquiry-chat-actions"><button type="button" className="secondary-btn" disabled>Send Message</button><button type="button" className="primary-btn" onClick={send} disabled={!canSchedule || loading || !text.trim()}>{loading ? 'Scheduling…' : 'Schedule Message'}</button></div>
        {scheduleStatus === 'scheduled' && <p className="inquiry-scheduled-notice" role="status">Your message is scheduled.</p>}
        {scheduleStatus === 'delivered' && <p className="inquiry-scheduled-notice" role="status">Your initial message has been delivered to the conversation.</p>}
        {scheduleStatus === 'cancelled' && <p className="muted">The scheduled message was cancelled because this session ended.</p>}
        {!canSchedule && scheduleStatus === 'Not scheduled' && <p className="muted">Scheduling is closed. Refresh this page when your session starts.</p>}
        {error && <div className="alert-box" role="alert">{error}</div>}
      </>}
  </div>;
}

function ChatPanel({ booking, role, onBookingChange, serverNow, fullPage = false }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [paymentMenuOpen, setPaymentMenuOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDescription, setPaymentDescription] = useState('');
  const [paymentMethodRequest, setPaymentMethodRequest] = useState(null);
  const [paymentChoice, setPaymentChoice] = useState('Wallet');
  const [walletPin, setWalletPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [localNow, setLocalNow] = useState(Date.now());
  const inputRef = useRef(null);
  const messageIdempotencyKey = useRef(null);
  const paymentIdempotencyKey = useRef(null);
  const navigate = useNavigate();
  const filePreviews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const now = serverNow ?? localNow;
  const sessionStart = new Date(booking.sessionStartedAt || booking.slotStart).getTime();
  const sessionEnd = new Date(booking.sessionEndsAt || booking.slotEnd).getTime();
  const active = ['Ready', 'In Progress'].includes(booking.status) && sessionStart <= now && sessionEnd > now;
  const remainingMs = Math.max(0, sessionEnd - now);
  const remainingMinutes = Math.ceil(remainingMs / 60000);

  useEffect(() => {
    let activeStream = true;
    request(`/api/inquiries/${booking.id}/messages`)
      .then((result) => { if (activeStream) { setMessages(result.messages); onBookingChange(result.booking); } })
      .catch((loadError) => { if (activeStream) setError(loadError.message); });
    let stream;
    if (booking.status === 'In Progress') {
      stream = new EventSource(`/api/inquiries/${booking.id}/stream`, { withCredentials: true });
      stream.addEventListener('update', (event) => {
        try {
          const result = JSON.parse(event.data);
          if (activeStream) { setMessages(result.messages); onBookingChange(result.booking); }
        } catch {
          if (activeStream) setError('A live chat update could not be read.');
        }
      });
      stream.addEventListener('ended', () => {
        if (activeStream) onBookingChange((current) => ({ ...current, status: 'Completed' }));
        stream.close();
        if (activeStream && role === 'customer') navigate('/inquiry', { replace: true, state: { sessionEnded: true } });
      });
      stream.addEventListener('revoked', () => stream.close());
      stream.addEventListener('error', () => {
        if (activeStream && stream.readyState === EventSource.CLOSED) setError('Live updates disconnected. Refresh to reconnect.');
      });
    }
    return () => { activeStream = false; if (stream) stream.close(); };
  }, [booking.id, booking.status, navigate, onBookingChange, role]);

  useEffect(() => {
    return () => filePreviews.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [filePreviews]);

  const addFiles = (selectedFiles) => {
    const incoming = Array.from(selectedFiles);
    const invalid = incoming.find((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      || file.size > 5 * 1024 * 1024);
    const remaining = Math.max(0, 3 - files.length);
    const accepted = incoming.filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      && file.size <= 5 * 1024 * 1024).slice(0, remaining);
    setFiles((current) => [...current, ...accepted]);
    setError(invalid ? `${invalid.size > 5 * 1024 * 1024 ? 'Each image must be 5 MB or smaller.' : 'Only JPEG, PNG, and WebP images are supported.'}`
      : incoming.length > remaining ? 'You can attach up to three images per message.' : '');
  };
  const handlePaste = (event) => {
    const images = [...(event.clipboardData?.items || [])]
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!images.length || booking.category !== 'Problem') return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText) setText((current) => `${current}${pastedText}`);
    addFiles(images);
  };

  useEffect(() => {
    const interval = window.setInterval(() => {
      setLocalNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim() && !files.length) return;
    setLoading(true);
    setError('');
    const body = new FormData();
    body.append('text', text);
    if (!messageIdempotencyKey.current) messageIdempotencyKey.current = crypto.randomUUID();
    body.append('clientMessageId', messageIdempotencyKey.current);
    files.forEach((file) => body.append('attachments', file));
    try {
      const result = await request(`/api/inquiries/${booking.id}/messages`, { method: 'POST', body });
      setMessages((current) => [...current.filter((message) => message.id !== result.message.id), result.message]);
      setText('');
      setFiles([]);
      messageIdempotencyKey.current = null;
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setLoading(false);
    }
  };

  const submitPaymentRequest = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await request(`/api/inquiries/${booking.id}/payment-requests`, {
        method: 'POST',
        body: JSON.stringify({
          amount: paymentAmount,
          description: paymentDescription,
          idempotencyKey: paymentIdempotencyKey.current || (paymentIdempotencyKey.current = crypto.randomUUID()),
        }),
      });
      setMessages((current) => [...current, result.message]);
      setPaymentDialogOpen(false);
      setPaymentMenuOpen(false);
      setPaymentAmount('');
      setPaymentDescription('');
      paymentIdempotencyKey.current = null;
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  const updatePaymentCard = (paymentRequest) => {
    setMessages((current) => current.map((message) => message.paymentRequestId === paymentRequest.id
      ? { ...message, paymentRequest }
      : message));
    setPaymentMethodRequest(null);
    setWalletPin('');
  };
  const payFromWallet = async (event) => {
    event.preventDefault();
    if (!paymentMethodRequest) return;
    setLoading(true);
    setError('');
    try {
      const result = await request(`/api/inquiry-payment-requests/${paymentMethodRequest.id}/wallet/pay`, {
        method: 'POST',
        body: JSON.stringify({ pin: walletPin }),
      });
      updatePaymentCard(result.paymentRequest);
    } catch (paymentError) {
      setError(paymentError.message);
    } finally {
      setLoading(false);
    }
  };
  const payWithRazorpay = async () => {
    if (!paymentMethodRequest) return;
    if (!window.Razorpay) {
      setError('Razorpay Checkout could not be loaded. Please try again.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const order = await request(`/api/inquiry-payment-requests/${paymentMethodRequest.id}/razorpay/order`, { method: 'POST', body: '{}' });
      let paymentHandled = false;
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        name: 'Innovation Labs',
        description: paymentMethodRequest.description,
        order_id: order.orderId,
        handler: async (response) => {
          paymentHandled = true;
          try {
            const result = await request(`/api/inquiry-payment-requests/${paymentMethodRequest.id}/razorpay/verify`, {
              method: 'POST',
              body: JSON.stringify(response),
            });
            updatePaymentCard(result.paymentRequest);
          } catch (paymentError) {
            setError(paymentError.message);
          } finally {
            setLoading(false);
          }
        },
        modal: { ondismiss: () => {
          if (!paymentHandled) {
            request(`/api/inquiry-payment-attempts/${encodeURIComponent(order.orderId)}/status`, {
              method: 'POST',
              body: JSON.stringify({ status: 'Cancelled' }),
            }).catch((cancelError) => setError(cancelError.message));
          }
          setLoading(false);
        } },
        theme: { color: '#00d1ff' },
      });
      checkout.on('payment.failed', (failure) => {
        paymentHandled = true;
        request(`/api/inquiry-payment-attempts/${encodeURIComponent(order.orderId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'Failed' }),
        }).catch((failureError) => setError(failureError.message));
        setError(failure.error?.description || 'Payment was not completed. You can safely retry.');
        setLoading(false);
      });
      checkout.open();
    } catch (paymentError) {
      setError(paymentError.message);
      setLoading(false);
    }
  };
  const cancelPaymentRequest = async (paymentRequest) => {
    setLoading(true);
    setError('');
    try {
      const result = await request(`/api/admin/inquiry-payment-requests/${paymentRequest.id}/cancel`, { method: 'POST', body: '{}' });
      updatePaymentCard(result.paymentRequest);
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setLoading(false);
    }
  };

  return <section className={`inquiry-chat-panel${fullPage ? ' inquiry-chat-panel-full' : ''}`}>
    <header className="inquiry-chat-header"><div><span className="eyebrow">{role === 'admin' ? 'ADMIN CONVERSATION' : 'LIVE SUPPORT'}</span><h3>{booking.customerName || 'Support session'} · {booking.token || 'Token pending'}</h3></div><span className={active ? 'inquiry-live-badge' : 'inquiry-ended-badge'}>{active ? `${remainingMinutes} min left` : booking.status}</span></header>
    {active && remainingMs <= 5 * 60 * 1000 && remainingMs > 0 && <p className="inquiry-session-warning" role="status">Your session will end in five minutes or less.</p>}
    <div className="inquiry-chat-messages" aria-live="polite">
      {messages.map((message) => <article className={`inquiry-chat-message ${message.authorRole === role ? 'mine' : ''}`} key={message.id}>
        <small>{message.authorRole === 'admin' ? 'Innovation Labs' : booking.customerName || 'You'} · {new Date(message.createdAt).toLocaleTimeString()}</small>
        {message.text && <p>{message.text}</p>}
        {message.attachments.map((attachment) => <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.name} /><span>{attachment.name}</span></a>)}
        {message.paymentRequest && <section className="inquiry-payment-card">
          <strong>Payment Request — Innovation Labs</strong>
          {Number(message.paymentRequest.subscriptionDiscountAmountPaise || 0) > 0 && <span>Original: ₹{(message.paymentRequest.baseAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · Subscription discount: −₹{(message.paymentRequest.subscriptionDiscountAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>}
          <span>Amount: ₹{(message.paymentRequest.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          <p>{message.paymentRequest.description}</p>
          <span>Status: <b>{message.paymentRequest.status}</b>{message.paymentRequest.paymentMethod ? ` · ${message.paymentRequest.paymentMethod}` : ''}</span>
          {role === 'customer' && message.paymentRequest.status === 'Pending' && <button className="primary-btn small" type="button" disabled={loading} onClick={() => setPaymentMethodRequest(message.paymentRequest)}>Pay Now</button>}
          {role === 'admin' && message.paymentRequest.status === 'Pending' && <button className="secondary-btn small" type="button" disabled={loading} onClick={() => cancelPaymentRequest(message.paymentRequest)}>Cancel request</button>}
          {message.paymentRequest.paymentReference && <small>Reference: {message.paymentRequest.paymentReference}</small>}
        </section>}
      </article>)}
      {!messages.length && <p className="muted">Your messages will appear here when the session begins.</p>}
    </div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    <form className="inquiry-chat-compose" onSubmit={submit}>
      <div className="inquiry-chat-input-row">
        {role === 'admin' && <div className="inquiry-chat-action-menu">
          <button type="button" className="inquiry-chat-plus" aria-label="More message actions" aria-expanded={paymentMenuOpen} disabled={!active || loading} onClick={() => setPaymentMenuOpen((open) => !open)}>+</button>
          {paymentMenuOpen && <button type="button" className="inquiry-chat-menu-item" onClick={() => { setPaymentDialogOpen(true); setPaymentMenuOpen(false); }}>Request Payment</button>}
        </div>}
        <textarea value={text} onChange={(event) => setText(event.target.value)} onPaste={handlePaste} maxLength={4000} disabled={!active || loading} placeholder={active ? 'Write a message…' : 'This conversation is not active.'} />
        <button className="primary-btn" type="submit" disabled={!active || loading || (!text.trim() && !files.length)}>{loading ? 'Sending…' : 'Send Message'}</button>
      </div>
      {booking.category === 'Problem' && <div className="inquiry-attachment-row"><label className="secondary-btn small">Attach image<input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden disabled={!active || loading} onChange={(event) => { addFiles(event.target.files || []); event.target.value = ''; }} /></label><small>Images up to 5 MB each. You can also paste an image.</small></div>}
      {loading && files.length > 0 && <p className="muted" role="status">Uploading {files.length} image{files.length === 1 ? '' : 's'}…</p>}
      {filePreviews.length > 0 && <div className="inquiry-file-list">{filePreviews.map(({ file, url }, index) => <span key={`${file.name}-${index}`}><img src={url} alt={`Preview of ${file.name}`} /><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={loading} onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>×</button></span>)}</div>}
    </form>
    {paymentDialogOpen && <div className="inquiry-modal-backdrop" role="presentation"><form className="inquiry-modal inquiry-payment-modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-payment-request-title" onSubmit={submitPaymentRequest}>
      <span className="eyebrow">LIVE CONVERSATION</span><h2 id="inquiry-payment-request-title">Request payment</h2>
      <label className="inquiry-field">Amount in INR (₹)<input type="number" min="1" max="1000000" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} required /></label>
      <label className="inquiry-field">Description<textarea maxLength={300} value={paymentDescription} onChange={(event) => setPaymentDescription(event.target.value)} required /></label>
      <div className="modal-actions"><button type="button" className="secondary-btn" disabled={loading} onClick={() => setPaymentDialogOpen(false)}>Cancel</button><button type="submit" className="primary-btn" disabled={loading}>{loading ? 'Sending…' : 'Send Payment Request'}</button></div>
    </form></div>}
    {paymentMethodRequest && <div className="inquiry-modal-backdrop" role="presentation"><section className="inquiry-modal inquiry-payment-modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-payment-method-title">
      <span className="eyebrow">SECURE PAYMENT</span><h2 id="inquiry-payment-method-title">Choose payment method</h2>
      <p>{paymentMethodRequest.subscriptionDiscountAmountPaise > 0 && `Original ₹${(paymentMethodRequest.baseAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · ${paymentMethodRequest.subscriptionDiscountPercent}% off · `}Pay ₹{(paymentMethodRequest.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · {paymentMethodRequest.description}</p>
      <fieldset className="inquiry-payment-choices"><legend>Payment method</legend>
        <label><input type="radio" name={`payment-${paymentMethodRequest.id}`} checked={paymentChoice === 'Wallet'} onChange={() => setPaymentChoice('Wallet')} /> Innovation Labs Wallet</label>
        <label><input type="radio" name={`payment-${paymentMethodRequest.id}`} checked={paymentChoice === 'Razorpay'} onChange={() => setPaymentChoice('Razorpay')} /> Razorpay</label>
      </fieldset>
      {paymentChoice === 'Wallet'
        ? <form className="inquiry-wallet-payment" onSubmit={payFromWallet}><label className="inquiry-field">Wallet PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={walletPin} onChange={(event) => setWalletPin(event.target.value.replace(/\D/g, '').slice(0, 4))} required /></label><button className="primary-btn full" type="submit" disabled={loading || walletPin.length !== 4}>{loading ? 'Processing…' : 'Pay with Wallet'}</button></form>
        : <button className="primary-btn full" type="button" disabled={loading} onClick={payWithRazorpay}>{loading ? 'Preparing…' : 'Continue with Razorpay'}</button>}
      <button className="secondary-btn full" type="button" disabled={loading} onClick={() => { setPaymentMethodRequest(null); setWalletPin(''); }}>Cancel</button>
    </section></div>}
  </section>;
}

export function AdminInquiriesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const isNext = location.pathname.endsWith('/next');
  const [bookings, setBookings] = useState([]);
  const [nextBooking, setNextBooking] = useState(null);
  const [settings, setSettings] = useState(null);
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [startEligibility, setStartEligibility] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [timezoneInput, setTimezoneInput] = useState('');
  const [openTimeInput, setOpenTimeInput] = useState('');
  const [closeTimeInput, setCloseTimeInput] = useState('');
  const [workingDaysInput, setWorkingDaysInput] = useState([]);

  const loadBookings = useCallback(async () => {
    const result = await request(`/api/admin/inquiries?page=${page}&limit=20&search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&category=${encodeURIComponent(category)}`);
    setBookings(result.bookings);
    setTotal(result.total);
  }, [page, search, status, category]);
  const loadNext = useCallback(async () => {
    const result = await request('/api/admin/inquiries/next');
    setNextBooking(result.booking);
  }, []);
  const loadSettings = useCallback(async () => {
    const result = await request('/api/admin/inquiries/config');
    setSettings(result.settings);
    setTimezoneInput(result.settings.timezone);
    setOpenTimeInput(result.settings.openTime);
    setCloseTimeInput(result.settings.closeTime);
    setWorkingDaysInput(result.settings.workingDays);
  }, []);

  useEffect(() => {
    setLoading(true);
    const tasks = isNext ? [loadNext()] : [loadBookings()];
    if (!settings) tasks.push(loadSettings());
    Promise.all(tasks).catch((loadError) => setError(loadError.message)).finally(() => setLoading(false));
  }, [isNext, loadBookings, loadNext, loadSettings, settings]);

  useEffect(() => {
    if (!selectedBooking?.id || selectedBooking.status !== 'In Progress') return undefined;
    const interval = window.setInterval(() => {
      loadBookings().catch((loadError) => setError(loadError.message));
      loadNext().catch((loadError) => setError(loadError.message));
    }, 5000);
    return () => window.clearInterval(interval);
  }, [selectedBooking?.id, selectedBooking?.status, loadBookings, loadNext]);

  const selectBooking = async (item) => {
    setError('');
    setNotice('');
    setStartEligibility(null);
    try {
      const [result, eligibility] = await Promise.all([
        request(`/api/inquiries/${item.id}/messages`),
        request(`/api/admin/inquiries/${item.id}/start-eligibility`),
      ]);
      setSelectedBooking(result.booking);
      setStartEligibility(eligibility);
    } catch (loadError) {
      setError(loadError.message);
    }
  };
  useEffect(() => {
    if (!selectedBooking?.id || !['Upcoming', 'Ready'].includes(selectedBooking.status)) return undefined;
    let active = true;
    const refreshEligibility = () => request(`/api/admin/inquiries/${selectedBooking.id}/start-eligibility`)
      .then((result) => { if (active) setStartEligibility(result); })
      .catch((loadError) => { if (active) setError(loadError.message); });
    const interval = window.setInterval(refreshEligibility, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [selectedBooking?.id, selectedBooking?.status]);
  const updateBooking = async (action, booking) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(`/api/admin/inquiries/${booking.id}/${action}`, { method: 'POST', body: '{}' });
      setSelectedBooking(result.booking);
      setNotice(action === 'start' ? 'Conversation opened.' : action === 'stop' ? 'Chat ended.' : 'Booking cancelled.');
      if (action === 'start') {
        setSelectedBooking(null);
        navigate(`/admin/inquiries/chat/${result.booking.id}`);
        return;
      }
      await Promise.all([loadBookings(), loadNext()]);
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request('/api/admin/inquiries/config', {
        method: 'PUT',
        body: JSON.stringify({ timezone: timezoneInput, openTime: openTimeInput, closeTime: closeTimeInput, workingDays: workingDaysInput }),
      });
      setSettings(result.settings);
      setNotice('Business hours saved.');
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleDay = (day) => setWorkingDaysInput((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort());
  const timezone = settings?.timezone || 'Asia/Kolkata';
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return <div className="inquiry-admin">
    <div className="inquiry-admin-top"><div><span className="eyebrow">OPERATIONS / CUSTOMER SUPPORT</span><h2>Inquiry bookings</h2><p>Manage availability, upcoming sessions, and authorized conversations.</p></div><nav><Link className={isNext ? '' : 'active'} to="/admin/inquiries">All Bookings</Link><Link className={isNext ? 'active' : ''} to="/admin/inquiries/next">Next Enquiry</Link></nav></div>
    {error && <div className="alert-box" role="alert">{error}</div>}{notice && <div className="inquiry-success-banner" role="status">{notice}</div>}
    {loading && <div className="empty-state"><h3>Loading inquiry operations…</h3></div>}
    {!loading && isNext && <div className="inquiry-admin-next">
      {nextBooking ? <article className="inquiry-admin-booking inquiry-next-card" onClick={() => selectBooking(nextBooking)}><span className="eyebrow">NEXT ELIGIBLE SESSION</span><h3>{nextBooking.customerName} · {nextBooking.token || 'Token awaiting generation'}</h3><p>{nextBooking.category === 'Inquiry' ? 'General Inquiry' : nextBooking.category} · {formatDate(nextBooking.dateKey, timezone)} · {formatTime(nextBooking.slotStart, timezone)}</p><span className="inquiry-status">{nextBooking.status}</span><button className="primary-btn small" type="button" onClick={(event) => { event.stopPropagation(); selectBooking(nextBooking); }}>Review booking</button></article> : <div className="empty-state"><h3>No upcoming bookings</h3><p>New eligible sessions will appear here.</p></div>}
    </div>}
    {!loading && !isNext && <div className="inquiry-admin-list">
      <div className="inquiry-admin-filters"><input aria-label="Search bookings" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search customer, email, phone, token" /><select aria-label="Filter by category" value={category} onChange={(event) => { setPage(1); setCategory(event.target.value); }}><option value="">All categories</option><option>General Inquiry</option><option>Inquiry</option><option>Problem</option></select><select aria-label="Filter by status" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">All statuses</option>{['Upcoming', 'Ready', 'In Progress', 'Completed', 'Cancelled', 'Expired'].map((value) => <option key={value}>{value}</option>)}</select></div>
      {bookings.length ? <div className="inquiry-admin-booking-list">{bookings.map((item) => <article className="inquiry-admin-booking" key={item.id} onClick={() => selectBooking(item)}><div><span className="eyebrow">{item.category === 'Inquiry' ? 'General Inquiry' : item.category} · {item.token || 'Token not generated'}</span><h3>{item.customerName}</h3><p>{item.customerEmail} · {item.phoneNumber}</p></div><div><strong>{formatDate(item.dateKey, timezone)}</strong><span>{formatTime(item.slotStart, timezone)} – {formatTime(item.slotEnd, timezone)}</span><span className="inquiry-status">Booking: {bookingStatusLabel(item)}</span><small>{item.subscriptionPlan === 'Exclusive' && item.priorityBooking ? 'Exclusive priority booking' : `${item.subscriptionPlan || 'Starter'} subscription`}</small><small>Token status: {tokenStatusLabel(item)}</small><small>Scheduled message: {item.scheduledMessageStatus || 'Not scheduled'}</small></div><button className="secondary-btn small" type="button" onClick={(event) => { event.stopPropagation(); selectBooking(item); }}>Details</button></article>)}</div> : <div className="empty-state"><h3>No bookings match these filters.</h3></div>}
      <div className="inquiry-pagination"><button className="secondary-btn small" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} · {total} bookings</span><button className="secondary-btn small" type="button" disabled={page * 20 >= total} onClick={() => setPage((value) => value + 1)}>Next</button></div>
    </div>}
    {!loading && <form className="inquiry-card inquiry-business-settings" onSubmit={saveSettings}>
      <div><span className="eyebrow">AVAILABILITY</span><h3>Business hours and timezone</h3></div>
      <label className="inquiry-field">IANA timezone<input value={timezoneInput} onChange={(event) => setTimezoneInput(event.target.value)} placeholder="Asia/Kolkata" /></label>
      <div className="inquiry-time-fields"><label className="inquiry-field">Opens<input type="time" step="1800" value={openTimeInput} onChange={(event) => setOpenTimeInput(event.target.value)} /></label><label className="inquiry-field">Closes<input type="time" step="1800" value={closeTimeInput} onChange={(event) => setCloseTimeInput(event.target.value)} /></label></div>
      <fieldset><legend>Working days</legend><div className="inquiry-day-options">{dayLabels.map((label, index) => <label key={label}><input type="checkbox" checked={workingDaysInput.includes(index)} onChange={() => toggleDay(index)} />{label}</label>)}</div></fieldset>
      <button type="submit" className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save business hours'}</button>
    </form>}

    {selectedBooking && <div className="inquiry-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedBooking(null); }}>
      <section className="inquiry-modal inquiry-admin-modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-admin-modal-title"><button className="inquiry-modal-close" type="button" aria-label="Close details" onClick={() => setSelectedBooking(null)}>×</button>
        <span className="eyebrow">BOOKING DETAILS</span><h2 id="inquiry-admin-modal-title">{selectedBooking.customerName} · {selectedBooking.token || 'Token awaiting generation'}</h2>
        <dl><div><dt>Email</dt><dd>{selectedBooking.customerEmail}</dd></div><div><dt>Phone</dt><dd>{selectedBooking.phoneNumber}</dd></div><div><dt>Category</dt><dd>{selectedBooking.category === 'Inquiry' ? 'General Inquiry' : selectedBooking.category}</dd></div><div><dt>Date</dt><dd>{formatDate(selectedBooking.dateKey, timezone)}</dd></div><div><dt>Time</dt><dd>{formatTime(selectedBooking.slotStart, timezone)} – {formatTime(selectedBooking.slotEnd, timezone)}</dd></div><div><dt>Subscription</dt><dd>{selectedBooking.subscriptionPlan === 'Exclusive' ? 'Exclusive · Priority booking' : selectedBooking.subscriptionPlan || 'Starter'}</dd></div><div><dt>Booking status</dt><dd>{bookingStatusLabel(selectedBooking)}</dd></div><div><dt>Token status</dt><dd>{tokenStatusLabel(selectedBooking)}</dd></div><div><dt>Token</dt><dd>{selectedBooking.token || 'Not generated yet'}</dd></div><div><dt>Scheduled message</dt><dd>{selectedBooking.scheduledMessageStatus || 'Not scheduled'}</dd></div></dl>
        {selectedBooking.status === 'In Progress' ? <div className="inquiry-admin-modal-actions"><button className="primary-btn" type="button" onClick={() => navigate(`/admin/inquiries/chat/${selectedBooking.id}`)}>Open Full-Page Chat</button><button className="secondary-btn" type="button" disabled={busy} onClick={() => updateBooking('stop', selectedBooking)}>{busy ? 'Working…' : 'Stop Chat'}</button></div>
          : <div className="inquiry-admin-modal-actions">{['Upcoming', 'Ready'].includes(selectedBooking.status) && <>
            {startEligibility
              ? !startEligibility.eligible && <div className="alert-box" role="status"><strong>{startEligibility.message.startsWith('Cannot Start Chat Yet') ? 'Cannot Start Chat Yet' : 'Chat Not Available Yet'}</strong><p>{startEligibility.message.replace(/^Cannot Start Chat Yet\.\s*/, '')}</p></div>
              : <p className="muted">Checking token and booking-time eligibility…</p>}
            <button type="button" className="primary-btn" disabled={busy || !startEligibility?.eligible} onClick={() => updateBooking('start', selectedBooking)}>{busy ? 'Opening…' : 'Start and Activate Chat'}</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => updateBooking('cancel', selectedBooking)}>Cancel booking</button>
          </>}</div>}
      </section>
    </div>}
  </div>;
}

export function AdminInquiryChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState(null);
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      request(`/api/inquiries/${encodeURIComponent(sessionId)}/messages`),
      request('/api/admin/inquiries/config'),
    ]).then(([session, config]) => {
      if (!mounted) return;
      setBooking(session.booking);
      setTimezone(config.settings.timezone);
    }).catch((loadError) => {
      if (mounted) setError(loadError.message);
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [sessionId]);

  const stopChat = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await request(`/api/admin/inquiries/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', body: '{}' });
      setBooking(result.booking);
    } catch (stopError) {
      setError(stopError.message);
    } finally {
      setBusy(false);
    }
  };

  return <section className="inquiry-chat-page" aria-label="Inquiry chat">
    <button className="secondary-btn small" type="button" onClick={() => navigate('/admin/inquiries')}>← Back to inquiry bookings</button>
    {loading && <div className="empty-state"><h2>Loading inquiry chat…</h2></div>}
    {error && <div className="alert-box" role="alert">{error}</div>}
    {booking && <>
      <header className="inquiry-chat-page-header">
        <div><span className="eyebrow">CUSTOMER INQUIRY · {booking.bookingReference}</span><h1>{booking.customerName}</h1><p>{booking.customerEmail} · {booking.category === 'Inquiry' ? 'General Inquiry' : booking.category} · Token {booking.token || 'Not generated'}</p></div>
        <div className="inquiry-chat-page-meta"><span>{formatDate(booking.dateKey, timezone)}</span><strong>{formatTime(booking.slotStart, timezone)} – {formatTime(booking.slotEnd, timezone)}</strong><span className={booking.status === 'In Progress' ? 'inquiry-live-badge' : 'inquiry-ended-badge'}>{booking.status}</span></div>
      </header>
      <ChatPanel booking={booking} role="admin" onBookingChange={setBooking} fullPage />
      {booking.status === 'In Progress' && <button className="secondary-btn inquiry-stop-chat" type="button" disabled={busy} onClick={stopChat}>{busy ? 'Stopping…' : 'Stop Chat'}</button>}
    </>}
  </section>;
}

export function NotOrderedPage() {
  const [attempts, setAttempts] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const limit = 20;

  const loadAttempts = useCallback(async () => {
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      search,
      status,
      from,
      to,
    });
    const result = await request(`/api/admin/checkout-attempts?${query}`);
    setAttempts(result.attempts);
    setTotal(result.total);
  }, [page, search, status, from, to]);

  useEffect(() => {
    setLoading(true);
    loadAttempts().catch((loadError) => setError(loadError.message)).finally(() => setLoading(false));
  }, [loadAttempts]);

  const submitSearch = (event) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchText.trim());
  };
  const money = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const dateTime = (value) => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  return <section className="not-ordered-page">
    <header className="inquiry-admin-top"><div><span className="eyebrow">ADMIN / CHECKOUT RECOVERY</span><h2>Not Ordered</h2><p>Customer checkouts that were cancelled or interrupted before an order was completed.</p></div></header>
    <form className="not-ordered-filters" onSubmit={submitSearch}>
      <label>Customer search<input value={searchText} onChange={(event) => setSearchText(event.target.value)} maxLength={80} placeholder="Search customer name, email, phone, or reference" /></label>
      <button className="primary-btn" type="submit" disabled={loading}>Search</button>
      <label>Status<select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}><option value="">All unsuccessful</option><option>Explicitly Cancelled</option><option>Interrupted</option><option>Payment Review</option></select></label>
      <label>From<input type="date" value={from} onChange={(event) => { setPage(1); setFrom(event.target.value); }} /></label>
      <label>To<input type="date" value={to} onChange={(event) => { setPage(1); setTo(event.target.value); }} /></label>
    </form>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {loading ? <div className="empty-state"><h3>Loading checkout attempts…</h3></div> : attempts.length ? <div className="not-ordered-table-wrap">
      <table className="not-ordered-table"><thead><tr><th>Customer</th><th>Items</th><th>Total</th><th>Date</th><th>Stage</th><th>Status</th><th>Reference</th><th /></tr></thead>
        <tbody>{attempts.map((attempt) => <tr key={attempt.reference} onClick={() => setSelected(attempt)}><td><strong>{attempt.customerName}</strong><small>{attempt.customerEmail}</small><small>{attempt.customerPhone || attempt.userId}</small></td>
          <td>{attempt.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}</td><td>{money(attempt.totalPaise)}</td><td>{dateTime(attempt.createdAt)}</td><td>{attempt.stage}</td><td>{attempt.status}</td><td>{attempt.reference}</td><td><button className="secondary-btn small" type="button" onClick={(event) => { event.stopPropagation(); setSelected(attempt); }}>Details</button></td></tr>)}</tbody>
      </table>
    </div> : <div className="empty-state"><h3>No unsuccessful checkout attempts found.</h3><p>Try changing the search or date filters.</p></div>}
    <div className="inquiry-pagination"><button className="secondary-btn small" type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {page} · {total} attempts</span><button className="secondary-btn small" type="button" disabled={loading || page * limit >= total} onClick={() => setPage((current) => current + 1)}>Next</button></div>
    {selected && <div className="inquiry-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="inquiry-modal inquiry-admin-modal not-ordered-details" role="dialog" aria-modal="true" aria-labelledby="not-ordered-title">
        <button className="inquiry-modal-close" type="button" aria-label="Close checkout details" onClick={() => setSelected(null)}>×</button>
        <span className="eyebrow">CHECKOUT ATTEMPT · {selected.status}</span><h2 id="not-ordered-title">{selected.customerName}</h2>
        <dl><div><dt>Email</dt><dd>{selected.customerEmail}</dd></div><div><dt>Phone</dt><dd>{selected.customerPhone || 'Not provided'}</dd></div><div><dt>Customer ID</dt><dd>{selected.userId}</dd></div><div><dt>Reference</dt><dd>{selected.reference}</dd></div><div><dt>Checkout stage</dt><dd>{selected.stage}</dd></div><div><dt>Payment status</dt><dd>{selected.paymentStatus}</dd></div><div><dt>Attempted total</dt><dd>{money(selected.totalPaise)} {selected.currency}</dd></div><div><dt>Created</dt><dd>{dateTime(selected.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{dateTime(selected.updatedAt)}</dd></div><div><dt>Exit recorded</dt><dd>{selected.exitedAt ? dateTime(selected.exitedAt) : 'Not recorded'}</dd></div><div><dt>Reason</dt><dd>{selected.reason || 'Not provided'}</dd></div></dl>
        <h3>Attempted products</h3><div className="not-ordered-item-list">{selected.items.map((item, index) => <div key={`${item.id}-${index}`}><span>{item.name} × {item.quantity}</span><strong>{money(item.unitPricePaise)} each</strong></div>)}</div>
        <div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setSelected(null)}>Close</button></div>
      </section>
    </div>}
  </section>;
}
