import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useLocation, useParams, useSearchParams } from 'react-router-dom';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
let googleIdentityInitialized = false;

const SOCIAL_LINKS = {
  whatsapp: '',
  facebook: '',
  instagram: '',
  youtube: 'https://www.youtube.com/@ArduinoProjectMakers',
  linkedin: 'https://www.linkedin.com/in/ankit-bhattacharya-1a40a8442/',
  twitter: 'https://x.com/AnkitBhattq2sk',
};

const FOOTER_POLICY_LINKS = {
  privacy: '',
  terms: '',
  refund: '',
  shipping: '',
  contact: '',
};

const socialPlatforms = {
  whatsapp: { label: 'WhatsApp', icon: <><path d="M20.1 11.8a8.2 8.2 0 0 1-12.2 7.1L3 20l1.2-4.7a8.2 8.2 0 1 1 15.9-3.5Z" /><path d="M8.1 7.8c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.8 1.9c.1.2 0 .4-.1.6l-.6.7c-.2.2-.2.4 0 .7.5.8 1.2 1.5 2 1.9.3.2.5.2.7-.1l.8-.9c.2-.2.4-.2.7-.1l1.8.9c.3.1.4.3.4.5 0 .3-.2 1.2-.8 1.6-.5.4-1.2.7-2 .5-1-.2-2.4-.8-3.8-2.1-1.2-1.1-2-2.5-2.2-3.4-.3-.9 0-1.7.4-2.2Z" /></> },
  facebook: { label: 'Facebook', icon: <path className="social-icon-fill" d="M13.5 21v-8h2.7l.4-3.1h-3.1v-2c0-.9.3-1.5 1.6-1.5h1.7V3.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.1H7.3V13h2.8v8h3.4Z" /> },
  instagram: { label: 'Instagram', icon: <><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5" /><circle cx="12" cy="12" r="4.1" /><circle cx="17.8" cy="6.5" r=".8" className="social-icon-fill" /></> },
  youtube: { label: 'YouTube', icon: <><path d="M22 8.2a2.8 2.8 0 0 0-2-2C18.2 5.7 12 5.7 12 5.7s-6.2 0-8 .5a2.8 2.8 0 0 0-2 2A29 29 0 0 0 1.5 12a29 29 0 0 0 .5 3.8 2.8 2.8 0 0 0 2 2c1.8.5 8 .5 8 .5s6.2 0 8-.5a2.8 2.8 0 0 0 2-2 29 29 0 0 0 .5-3.8 29 29 0 0 0-.5-3.8Z" /><path d="m10 15.3 5.2-3.3L10 8.7v6.6Z" className="social-icon-fill" /></> },
  linkedin: { label: 'LinkedIn', icon: <path className="social-icon-fill" d="M5.1 8.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM3.5 10h3.2v10H3.5zM9 10h3.1v1.4h.1a3.4 3.4 0 0 1 3.1-1.7c3.3 0 3.9 2.1 3.9 4.8V20H16v-4.9c0-1.2 0-2.7-1.7-2.7s-2 1.3-2 2.6V20H9V10Z" /> },
  twitter: { label: 'X', icon: <path className="social-icon-fill" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.9 5.8 22H2.6l7.3-8.4L2 2h6.5l4.5 6.7L18.9 2Zm-1.1 17.8h1.7L7.5 4.1H5.7l12.1 15.7Z" /> },
};

const productImages = {
  board: 'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?auto=format&fit=crop&w=800&q=80',
  sensor: 'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=800&q=80',
  motor: 'https://images.unsplash.com/photo-1555618566-5f49d8d6ce88?auto=format&fit=crop&w=800&q=80',
  display: 'https://images.unsplash.com/photo-1516321165247-4aa89a48be28?auto=format&fit=crop&w=800&q=80',
  wiring: 'https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=800&q=80',
};

const fallbackProductImage = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 800 440%22%3E%3Crect width=%22800%22 height=%22440%22 fill=%22%230d1f2a%22/%3E%3Cpath d=%22M0 330h800M0 350h800%22 stroke=%22%2300d1ff%22 stroke-opacity=%22.2%22 stroke-width=%222%22/%3E%3Crect x=%22330%22 y=%22150%22 width=%22140%22 height=%22140%22 rx=%2218%22 fill=%22%23122b38%22 stroke=%22%2300d1ff%22 stroke-opacity=%22.7%22 stroke-width=%224%22/%3E%3Cpath d=%22M370 190h60v60h-60zM300 180h30m-30 35h30m-30 35h30m140-70h30m-30 35h30m-30 35h30M350 120v30m40-30v30m40-30v30m-80 140v30m40-30v30m40-30v30%22 fill=%22none%22 stroke=%22%236ee7ff%22 stroke-width=%226%22 stroke-linecap=%22round%22/%3E%3C/svg%3E';
const browsingHistoryLimit = 1000;
const historyProductImage = (product) => product?.images?.[0]
  || (/sensor|module|driver/i.test(product?.category || '') ? productImages.sensor
    : /motor/i.test(product?.category || '') ? productImages.motor
      : /display|led|buzzer/i.test(product?.category || '') ? productImages.display
        : /wire|power|component/i.test(product?.category || '') ? productImages.wiring
          : productImages.board);

const mergeBrowsingHistory = (...groups) => {
  const byProduct = new Map();
  groups.flat().forEach((entry) => {
    if (!entry?.productId) return;
    const current = byProduct.get(entry.productId);
    if (!current || new Date(entry.viewedAt) > new Date(current.viewedAt)) byProduct.set(entry.productId, entry);
  });
  return [...byProduct.values()]
    .sort((left, right) => new Date(right.viewedAt) - new Date(left.viewedAt))
    .slice(0, browsingHistoryLimit);
};

const deliveryFor = (subtotal) => (subtotal > 800 ? 0 : subtotal > 0 ? 40 : 0);
const maxCartQuantity = (item) => item.discountOfferId && item.availableQuantity != null
  ? Math.max(0, Math.min(99, Math.floor(Number(item.availableQuantity))))
  : item.inventoryProduct && item.stock != null && Number.isFinite(Number(item.stock))
    ? Math.max(0, Math.min(99, Math.floor(Number(item.stock))))
    : 99;
const formatPromoCode = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).match(/.{1,4}/g)?.join('-') || '';
const refundStatusLabel = (status) => ({
  REFUND_PLACED: 'Refund Requested',
  ORDER_CHECK_PENDING: 'Order Check Pending',
  ORDER_CHECKING: 'Order Check',
  RETURN_REQUIRED: 'Return Required',
  PACKAGE_ARRIVED: 'Package Arrived',
  PART_CHECKING: 'Part Checking',
  ORDER_ACCEPTED: 'Refund Accepted',
  ORDER_DECLINED: 'Refund Declined',
  REFUND_PROCESSING: 'Refund Processing',
  REFUND_INITIATED: 'Refund Initialized',
  REFUND_CREDITED: 'Refund Credited',
  REFUND_COMPLETED: 'Refunded',
  REFUND_REJECTED: 'Refund Declined',
})[status] || 'Refund Update';

const initialAddress = {
  fullName: '',
  phoneNumber: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  pinCode: '',
  country: '',
};

const serviceOptions = [
  { id: 'parts', title: 'Parts Only', description: 'Only the selected components and accessories.' },
  { id: 'coding', title: 'Parts + Coding', description: 'Parts with firmware and software setup.' },
  { id: 'building', title: 'Parts + Building', description: 'Assembly and custom model fabrication.' },
  { id: 'full', title: 'Parts + Coding + Building', description: 'Everything from electronics to assembly and programming.' },
];

const parseJsonSafely = async (response) => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const requestApi = async (url, options = {}) => {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = await parseJsonSafely(response);
  if (!response.ok) {
    const error = new Error(result?.message || `Request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
};

const downloadInvoicePdf = async (url, invoiceNumber) => {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const result = await parseJsonSafely(response);
    throw new Error(result?.message || `Invoice download failed with status ${response.status}.`);
  }
  const blob = await response.blob();
  const header = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (header.length !== 5 || String.fromCharCode(...header) !== '%PDF-') {
    throw new Error('The invoice download did not contain a valid PDF. Please try again or contact support.');
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${invoiceNumber}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};

const appendVoiceText = (existingText, voiceText) => {
  const existing = existingText.trimEnd();
  const spoken = voiceText.trim();
  if (!spoken) return existingText;
  if (!existing) return spoken;

  const existingWords = existing.split(/\s+/);
  const spokenWords = spoken.split(/\s+/);
  const normalizeWord = (word) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const maxOverlap = Math.min(existingWords.length, spokenWords.length, 8);
  let overlap = 0;

  for (let count = maxOverlap; count > 0; count -= 1) {
    const left = existingWords.slice(-count).map(normalizeWord);
    const right = spokenWords.slice(0, count).map(normalizeWord);
    if (left.every((word, index) => word && word === right[index])) {
      overlap = count;
      break;
    }
  }

  const remainder = spokenWords.slice(overlap).join(' ');
  if (!remainder) return existingText;
  const separator = /[\s([{/-]$/.test(existing) ? '' : ' ';
  return `${existing}${separator}${remainder}`;
};

const normalizeOrderRecord = (order) => ({
  ...order,
  id: order.orderId || order.id,
  date: order.createdAt || order.date,
  customerName: order.userName || order.customerName,
  email: order.userEmail || order.email,
  walletBalanceAfter: order.walletBalanceAfterPaise == null ? order.walletBalanceAfter : order.walletBalanceAfterPaise / 100,
  orderStatus: order.orderStatus || 'Processing',
});

function App() {
  const [cart, setCart] = useState([]);
  const [wishlist, setWishlist] = useState([]);
  const [appliedDiscount, setAppliedDiscount] = useState(null);
  const [auth, setAuth] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [browsingHistory, setBrowsingHistory] = useState([]);
  const [browsingHistoryLoading, setBrowsingHistoryLoading] = useState(true);
  const [browsingHistoryError, setBrowsingHistoryError] = useState('');
  const [aiOpenSignal, setAiOpenSignal] = useState(0);
  const [cartOwnerId, setCartOwnerId] = useState(null);
  const [cartError, setCartError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [subscriptionData, setSubscriptionData] = useState(null);
  const [orders, setOrders] = useState([]);
  const [accountData, setAccountData] = useState(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [accountNotice, setAccountNotice] = useState('');
  const [savedAddresses, setSavedAddresses] = useState({});
  const [customOrders, setCustomOrders] = useState([]);
  const [adminCustomOrders, setAdminCustomOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [giftPopupNotification, setGiftPopupNotification] = useState(null);
  const [refunds, setRefunds] = useState([]);
  const [adminRefunds, setAdminRefunds] = useState([]);
  const [customOrderError, setCustomOrderError] = useState('');
  const [adminOrderError, setAdminOrderError] = useState('');
  const [adminPrices, setAdminPrices] = useState({});
  const [customItemName, setCustomItemName] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [selectedService, setSelectedService] = useState('parts');
  const [projectPreferences, setProjectPreferences] = useState('');
  const [checkoutStep, setCheckoutStep] = useState(1);
  const [address, setAddress] = useState({ ...initialAddress });
  const [modal, setModal] = useState({ open: false, kind: '', props: {} });
  const [walletAccessVersion, setWalletAccessVersion] = useState(0);
  const [loginAttempted, setLoginAttempted] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const reminderCountRef = useRef(0);
  const walletAccessRequestRef = useRef(0);
  const aiCartActionKeysRef = useRef(new Set());
  const cartSyncQueueRef = useRef(Promise.resolve());
  const walletPaymentKeyRef = useRef('');

  const trackProductView = useCallback(async (product) => {
    if (!product?.id) return;
    const viewedAt = new Date().toISOString();
    const entry = {
      productId: String(product.id),
      productName: product.name || String(product.id),
      viewedAt,
      product: { ...product },
    };
    setBrowsingHistory((current) => mergeBrowsingHistory([entry], current));
    setBrowsingHistoryError('');
    if (!auth) return;
    try {
      await requestApi('/api/browsing-history', {
        method: 'POST',
        body: JSON.stringify({ productId: entry.productId }),
      });
    } catch (error) {
      setBrowsingHistoryError(error.message);
      console.error('Could not record product browsing history:', error.message);
    }
  }, [auth?.id]);

  const removeProductFromHistory = async (productId) => {
    setBrowsingHistoryError('');
    try {
      if (auth) {
        await requestApi(`/api/browsing-history/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      }
      setBrowsingHistory((current) => current.filter((entry) => entry.productId !== productId));
    } catch (error) {
      setBrowsingHistoryError(error.message);
    }
  };

  const clearBrowsingHistory = async () => {
    setBrowsingHistoryError('');
    try {
      if (auth) {
        await requestApi('/api/browsing-history', { method: 'DELETE' });
      }
      setBrowsingHistory([]);
    } catch (error) {
      setBrowsingHistoryError(error.message);
    }
  };

  const openAIBuilder = () => {
    setAiOpenSignal((signal) => signal + 1);
    if (!auth) {
      openModal('google-login');
      return;
    }
  };

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) {
          const result = await parseJsonSafely(response);
          throw new Error(result?.message || `Sign-in status check failed with status ${response.status}.`);
        }
        return parseJsonSafely(response);
      })
      .then((result) => {
        setAuth(result?.user ? { ...result.user, requiresAdminVerification: Boolean(result.requiresAdminVerification) } : null);
        if (result?.requiresAdminVerification) {
          setModal({ open: true, kind: 'admin-verification', props: {} });
        }
      })
      .catch((error) => {
        setAuth(null);
        setAccountError(`Your sign-in status could not be checked: ${error.message}`);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    requestApi('/api/products').then((result) => {
      if (!active || !Array.isArray(result.products)) return;
      setCatalog(result.products.map((product) => ({
        ...product,
        price: Number(product.price),
        image: historyProductImage(product),
        inventoryProduct: Boolean(product.inventoryProduct),
      })));
      setCatalogError('');
    }).catch((error) => {
      if (active) setCatalogError(`The product catalogue could not be loaded: ${error.message}`);
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authLoading) return undefined;
    let active = true;
    const loadBrowsingHistory = async () => {
      setBrowsingHistoryLoading(true);
      setBrowsingHistoryError('');
      const guestEntries = browsingHistory;
      if (!auth) {
        setBrowsingHistoryLoading(false);
        return;
      }
      let syncError = '';
      try {
        if (guestEntries.length) {
          try {
            for (let offset = 0; offset < guestEntries.length; offset += 100) {
              await requestApi('/api/browsing-history/sync', {
                method: 'POST',
                body: JSON.stringify({ items: guestEntries.slice(offset, offset + 100) }),
              });
            }
          } catch (error) {
            syncError = `Guest browsing history could not be synchronized: ${error.message}`;
          }
        }
        const result = await requestApi('/api/browsing-history');
        if (!active) return;
        setBrowsingHistory(mergeBrowsingHistory(result.history || [], syncError ? guestEntries : []));
        if (syncError) setBrowsingHistoryError(syncError);
      } catch (error) {
        if (!active) return;
        setBrowsingHistory((current) => current.length ? current : guestEntries);
        setBrowsingHistoryError(error.message);
      } finally {
        if (active) setBrowsingHistoryLoading(false);
      }
    };
    loadBrowsingHistory();
    return () => { active = false; };
  }, [auth?.id, authLoading]);

  useEffect(() => {
    let active = true;
    const syncCartStock = async () => {
      try {
        const result = await requestApi('/api/products');
        if (!active || !Array.isArray(result.products)) return;
        const inventoryById = new Map(result.products.map((item) => [item.id, item]));
        setCart((current) => current.flatMap((cartItem) => {
          if (cartItem.promoReservationId || cartItem.customOrderId) return [cartItem];
          const product = inventoryById.get(cartItem.id);
          if (!product || !product.inventoryProduct || !Number.isFinite(Number(product.stock))) return [cartItem];
          const quantity = Math.min(cartItem.quantity, Math.max(0, Math.floor(Number(product.stock))));
          if (!quantity) return [];
          if (cartItem.stock === product.stock && cartItem.status === product.status && cartItem.quantity === quantity) return [cartItem];
          return [{ ...cartItem, inventoryProduct: true, stock: product.stock, status: product.status, quantity }];
        }));
      } catch (error) {
        if (active) setCartError(`Cart availability could not be refreshed: ${error.message}`);
      }
    };
    syncCartStock();
    const interval = window.setInterval(syncCartStock, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!auth) {
      setSubscriptionData(null);
      setAccountData(null);
      setCustomOrders([]);
      setNotifications([]);
      setAdminCustomOrders([]);
      setRefunds([]);
      setAdminRefunds([]);
      return;
    }

    let active = true;
    setAccountLoading(true);
    setAccountError('');
    requestApi('/api/subscription')
      .then((result) => { if (active) setSubscriptionData(result); })
      .catch((error) => { if (active) setAccountError(`Subscription details could not be loaded: ${error.message}`); });
    requestApi('/api/account')
      .then((result) => {
        if (!active) return;
        const profile = result.profile || {};
        const remoteOrders = (result.orders || []).map(normalizeOrderRecord);
        setAccountData(result);
        setOrders(remoteOrders);
        setCustomOrders(result.customOrders || []);
        setNotifications(result.notifications || []);
        if (profile.address) {
          setAddress({ ...initialAddress, ...profile.address });
        }
        setSavedAddresses({
          ...(profile.address ? { [auth.email]: profile.address } : {}),
          [`${auth.email}::promo-recipient-addresses`]: profile.recipientAddresses || [],
        });
        setCustomOrderError('');
      })
      .catch((error) => {
        if (active) {
          setAccountError(error.message);
        }
      })
      .finally(() => {
        if (active) setAccountLoading(false);
      });

    requestApi('/api/custom-orders')
      .then((result) => {
        if (!active) return;
        setCustomOrders(result.customOrders || []);
        setNotifications(result.notifications || []);
        setCustomOrderError('');
      })
      .catch((error) => {
        if (active) setCustomOrderError(`Custom orders are temporarily unavailable: ${error.message}`);
      });

    requestApi('/api/refunds')
      .then((result) => setRefunds(result.refunds || []))
      .catch((error) => { if (active) setAccountError(`Refund history could not be loaded: ${error.message}`); });

    if (auth.isAdmin) {
      requestApi('/api/admin/custom-orders')
        .then((result) => {
          if (active) setAdminCustomOrders(result.customOrders || []);
        })
        .catch((error) => {
          if (active) setAdminOrderError(error.message);
        });
      requestApi('/api/admin/refunds')
        .then((result) => { if (active) setAdminRefunds(result.refunds || []); })
        .catch((error) => { if (active) setAdminOrderError(`Admin refund data could not be loaded: ${error.message}`); });
    }

    return () => { active = false; };
  }, [auth]);

  useEffect(() => {
    if (!auth?.id) {
      setCartOwnerId(null);
      return undefined;
    }
    let active = true;
    setCartOwnerId(null);
    requestApi('/api/cart').then(({ items = [] }) => {
      if (!active) return;
      setCart((current) => {
        const remoteIds = new Set(items.map((item) => item.id));
        return [...items, ...current.filter((item) => !remoteIds.has(item.id))];
      });
      setCartOwnerId(auth.id);
    }).catch((error) => {
      if (active) setCartError(`Your saved cart could not be loaded: ${error.message}`);
    });
    return () => { active = false; };
  }, [auth?.id]);

  useEffect(() => {
    if (!auth?.id || cartOwnerId !== auth.id) return undefined;
    const items = cart;
    const timer = window.setTimeout(() => {
      cartSyncQueueRef.current = cartSyncQueueRef.current
        .catch(() => {})
        .then(() => requestApi('/api/cart', { method: 'PUT', body: JSON.stringify({ items }) }))
        .then(() => setCartError(''))
        .catch((error) => setCartError(`Your cart changes could not be saved: ${error.message}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [auth?.id, cartOwnerId, cart]);

  useEffect(() => {
    let active = true;
    const savedGuests = wishlist;
    const cartKeys = new Set(cart.map((item) => `${item.promoReservationId ? 'promo' : item.discountOfferId ? 'discount-code' : 'product'}:${item.promoReservationId ? item.promoCodeId : item.discountOfferId || item.id}`));
    const withoutCartItems = (items) => items.filter((item) => !cartKeys.has(`${item.productType}:${item.productId}`));
    if (!auth?.id) {
      const guestOnly = withoutCartItems(savedGuests);
      setWishlist(guestOnly);
      return () => { active = false; };
    }
    setWishlist([]);
    requestApi('/api/wishlist').then(async (result) => {
      const synced = savedGuests.length
        ? await requestApi('/api/wishlist/merge', { method: 'POST', body: JSON.stringify({ products: savedGuests }) })
        : result;
      if (!active) return;
      const syncedProducts = Array.isArray(synced.products) ? synced.products : [];
      const visibleProducts = withoutCartItems(syncedProducts);
      const cartOverlaps = syncedProducts.filter((item) => !visibleProducts.includes(item));
      await Promise.all(cartOverlaps.map((item) => requestApi(`/api/wishlist/items/${encodeURIComponent(item.productType)}/${encodeURIComponent(item.productId)}`, { method: 'DELETE' })));
      if (!active) return;
      setWishlist(visibleProducts);
    }).catch((error) => {
      if (active) {
        setWishlist([]);
        setAccountError(`Your wishlist could not be synchronized: ${error.message}`);
      }
    });
    return () => { active = false; };
  }, [auth?.id]);

  useEffect(() => {
    if (auth) {
      const current = savedAddresses[auth.email];
      setAddress(current ? { ...current } : { ...initialAddress });
    }
  }, [auth]);

  useEffect(() => {
    document.body.classList.toggle('modal-open', modal.open);
    return () => document.body.classList.remove('modal-open');
  }, [modal.open]);

  useEffect(() => {
    if (auth || modal.open) return;

    const timer = setTimeout(() => {
      reminderCountRef.current += 1;
      setModal({
        open: true,
        kind: 'signin-reminder',
        props: { repeat: reminderCountRef.current > 1 },
      });
    }, 120000);

    return () => clearTimeout(timer);
  }, [auth, modal.open, location.pathname]);

  useEffect(() => {
    const adminRoute = location.pathname === '/admin' || location.pathname.startsWith('/admin/');
    if (authLoading || !adminRoute) return;
    if (!auth) {
      navigate('/', { replace: true });
      setModal({ open: true, kind: 'require-signin', props: {} });
      return;
    }
    if (auth.requiresAdminVerification) {
      setModal((current) => current.kind === 'admin-verification' ? current : { open: true, kind: 'admin-verification', props: {} });
      return;
    }
    if (!auth.isAdmin) navigate('/account', { replace: true });
  }, [auth, authLoading, location.pathname, navigate]);

  useEffect(() => {
    const protectedRoute = location.pathname === '/orders' || location.pathname.startsWith('/account');
    if (authLoading || auth || !protectedRoute) return;
    navigate('/', { replace: true });
    setModal({ open: true, kind: 'require-signin', props: {} });
  }, [auth, authLoading, location.pathname, navigate]);

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const codingCharge = useMemo(() => {
    const physicalCart = cart.filter((item) => !item.discountOfferId && !item.promoReservationId);
    if (!physicalCart.length) return 0;
    if (selectedService === 'coding' || selectedService === 'full') {
      const partCount = physicalCart.reduce((sum, item) => sum + item.quantity, 0);
      const extraParts = Math.max(0, partCount - 3);
      return 700 + extraParts * 300;
    }
    return 0;
  }, [cart, selectedService]);

  const buildingCharge = useMemo(() => {
    if (!cart.some((item) => !item.discountOfferId && !item.promoReservationId)) return 0;
    if (selectedService === 'building' || selectedService === 'full') {
      return 1200;
    }
    return 0;
  }, [selectedService]);

  const physicalSubtotal = cart.reduce((sum, item) => sum + (item.discountOfferId || item.promoReservationId ? 0 : item.price * item.quantity), 0);
  const deliveryCharge = deliveryFor(physicalSubtotal);
  const grandTotal = Math.max(0, subtotal + codingCharge + buildingCharge + deliveryCharge - Number(appliedDiscount?.discountAmount || 0));

  const openModal = (kind, props = {}) => setModal({ open: true, kind, props });
  const closeModal = () => setModal({ open: false, kind: '', props: {} });
  const openWalletUnlock = async (fromDirectRoute = false) => {
    if (!auth) {
      openModal('google-login');
      return;
    }
    const requestId = walletAccessRequestRef.current + 1;
    walletAccessRequestRef.current = requestId;
    openModal('wallet-access-pin', { mode: 'unlock', fromDirectRoute, checking: true });
    try {
      const access = await requestApi('/api/wallet/access');
      if (walletAccessRequestRef.current === requestId) {
        setModal((current) => current.open && current.kind === 'wallet-access-pin'
          ? { ...current, props: { ...current.props, mode: access.setupRequired ? 'setup' : 'unlock', checking: false } }
          : current);
      }
    } catch (error) {
      if (walletAccessRequestRef.current === requestId) openModal('payment-error', { message: error.message });
    }
  };
  const submitWalletPin = async (pin, mode) => {
    await requestApi(mode === 'setup' ? '/api/wallet/pin' : '/api/wallet/unlock', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    closeModal();
    setWalletAccessVersion((version) => version + 1);
    navigate('/wallet');
  };
  const cancelWalletUnlock = () => {
    const fromDirectRoute = modal.props.fromDirectRoute;
    walletAccessRequestRef.current += 1;
    closeModal();
    if (fromDirectRoute && location.pathname === '/wallet') {
      if (window.history.state?.idx > 0) navigate(-1);
      else navigate('/', { replace: true });
    }
  };

  const openProjectPreferencesModal = () => {
    openModal('project-preferences', {
      value: projectPreferences,
      onSave: (value) => {
        setProjectPreferences(value);
        setCheckoutStep(2);
        closeModal();
      },
    });
  };

  const removeWishlistItem = async (productType, productId) => {
    const next = wishlist.filter((item) => !(item.productType === productType && String(item.productId) === String(productId)));
    if (!auth?.id) {
      setWishlist(next);
      return;
    }
    try {
      const result = await requestApi(`/api/wishlist/items/${encodeURIComponent(productType)}/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      setWishlist(result.products || []);
    } catch (error) {
      openModal('payment-error', { title: 'Wishlist Update Failed', message: error.message });
    }
  };

  const addWishlistItem = async (product, productType = 'product', allowInCart = false) => {
    const productId = String(product.productId || product.promoCodeId || product.discountOfferId || product.id || '').trim();
    if (!productId) return false;
    const alreadyInCart = cart.some((item) => productType === 'promo'
      ? String(item.promoCodeId || '') === productId
      : productType === 'discount-code'
        ? String(item.discountOfferId || '') === productId
        : String(item.id) === productId);
    if (alreadyInCart && !allowInCart) return false;
    if (auth?.id) {
      try {
        const result = await requestApi('/api/wishlist/items', {
          method: 'POST',
          body: JSON.stringify({ productId, productType }),
        });
        setWishlist(result.products || []);
        return true;
      } catch (error) {
        openModal('payment-error', { title: 'Wishlist Update Failed', message: error.message });
        return false;
      }
    }
    if (wishlist.some((item) => item.productType === productType && String(item.productId) === productId)) return true;
    const next = [{
      productId,
      productType,
      name: product.name,
      category: product.category,
      price: Number(product.price) || 0,
      image: product.image || '',
      availability: product.status || product.availability || 'In Stock',
      addedAt: new Date().toISOString(),
    }, ...wishlist];
    setWishlist(next);
    return true;
  };

  const addWishlistPromoToCart = async (product) => {
    if (cart.some((item) => !item.promoReservationId)) {
      openModal('payment-error', { title: 'Separate Checkout Required', message: 'Promo Codes must be purchased separately from physical products. Complete or clear your current cart first.' });
      return;
    }
    try {
      const reservationKey = globalThis.crypto?.randomUUID?.() || `wishlist-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const reservation = await requestApi('/api/promo-codes/reserve', {
        method: 'POST',
        body: JSON.stringify({ promoCodeId: product.productId, reservationKey, purchaseType: 'online', recipientType: 'myself' }),
      });
      handleAddPromoToCart({ id: product.productId, amount: product.price }, reservation);
    } catch (error) {
      openModal('payment-error', { title: 'Promo Code Unavailable', message: error.message });
    }
  };

  const moveCartItemToWishlist = async (item) => {
    const productType = item.promoReservationId ? 'promo' : item.discountOfferId ? 'discount-code' : 'product';
    const productId = item.promoReservationId ? item.promoCodeId : item.discountOfferId || item.id;
    const saved = await addWishlistItem({ ...item, id: productId, productId }, productType, true);
    if (!saved) return;
    setAppliedDiscount(null);
    setCart((current) => current.filter((cartItem) => cartItem.id !== item.id));
    if (item.promoReservationId) {
      requestApi(`/api/promo-codes/reservations/${encodeURIComponent(item.promoReservationId)}/release`, { method: 'POST' })
        .then(() => requestApi('/api/wishlist'))
        .then((result) => setWishlist(result.products || []))
        .catch((error) => setCartError(`The Promo Code reservation could not be released: ${error.message}`));
    }
  };

  const handleAddToCart = (product) => {
    if (cart.some((item) => item.promoReservationId)) {
      openModal('payment-error', { title: 'Separate Checkout Required', message: 'Promo Codes use a separate digital checkout. Complete or remove the Promo Code from your cart before adding physical products.' });
      return;
    }
    if (maxCartQuantity(product) < 1) return;
    setAppliedDiscount(null);
    setCart((curr) => {
      const limit = maxCartQuantity(product);
      const exists = curr.find((item) => item.id === product.id);
      if (exists) {
        const quantity = Math.min(limit, exists.quantity + 1);
        return quantity > 0
          ? curr.map((item) => item.id === product.id ? { ...item, ...product, quantity } : item)
          : curr.filter((item) => item.id !== product.id);
      }
      if (limit < 1) return curr;
      return [...curr, { ...product, quantity: 1 }];
    });
    if (!product.discountOfferId) removeWishlistItem('product', product.id);
  };

  const addProjectComponentsToCart = async (items, idempotencyKey) => {
    if (cart.some((item) => item.promoReservationId)) {
      throw new Error('Wallet Promo Codes must be checked out separately. Remove the Wallet Promo Code before adding project components.');
    }
    const result = await requestApi('/api/ai/add-components-to-cart', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey,
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          currentQuantity: cart.find((cartItem) => cartItem.id === item.productId)?.quantity || 0,
        })),
      }),
    });
    if (aiCartActionKeysRef.current.has(idempotencyKey)) return { ...result, alreadyApplied: true };
    if (result.added?.length) {
      let updatedCart = [...cart];
      result.added.forEach((item) => {
        const product = { ...item, image: item.images?.[0] || fallbackProductImage, availableQuantity: item.stock };
        const existing = updatedCart.find((cartItem) => cartItem.id === product.id);
        updatedCart = existing
          ? updatedCart.map((cartItem) => cartItem.id === product.id ? { ...cartItem, ...product, quantity: cartItem.quantity + item.quantity } : cartItem)
          : [...updatedCart, product];
      });
      await requestApi('/api/cart', { method: 'PUT', body: JSON.stringify({ items: updatedCart }) });
      aiCartActionKeysRef.current.add(idempotencyKey);
      setAppliedDiscount(null);
      setCart(updatedCart);
      result.added.forEach((item) => removeWishlistItem('product', item.id));
    }
    if (!result.added?.length) aiCartActionKeysRef.current.add(idempotencyKey);
    return result;
  };

  const prepareAiCheckout = async (projectDescription, paymentMethod = null) => {
    const result = await requestApi('/api/ai/checkout-assistance', {
      method: 'POST',
      body: JSON.stringify({
        items: cart,
        service: selectedService,
        projectDescription,
        ...(paymentMethod ? { paymentMethod } : {}),
      }),
    });
    setProjectPreferences(result.projectDescription);
    setCheckoutStep(1);
    navigate(result.checkoutPath, { state: { aiPaymentMethod: result.preferredPaymentMethod } });
    return result;
  };

  const openCustomBuilding = (projectDescription) => {
    setProjectPreferences(projectDescription);
    setCheckoutStep(1);
    navigate('/checkout');
  };

  const handleAddPromoToCart = (promo, reservation) => {
    if (cart.some((item) => !item.promoReservationId)) {
      openModal('payment-error', { title: 'Separate Checkout Required', message: 'Promo Codes must be purchased separately from physical products. Complete or clear your current cart first.' });
      requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservation.reservationId)}/release`, { method: 'POST' })
        .catch((error) => setCartError(`The Promo Code reservation could not be released: ${error.message}`));
      return;
    }
    setAppliedDiscount(null);
    setCart((current) => [...current, {
      id: `promo-${reservation.reservationId}`,
      name: 'Digital Wallet Credit',
      category: 'Promo Code',
      price: promo.amount,
      quantity: 1,
      image: productImages.display,
      promoCodeId: promo.id,
      promoReservationId: reservation.reservationId,
      purchaseType: reservation.purchaseType,
      recipientType: reservation.recipientType || 'myself',
    }]);
    removeWishlistItem('promo', promo.id);
  };

  const updateQuantity = (id, delta) => {
    const item = cart.find((cartItem) => cartItem.id === id);
    if (!item) return;
    setAppliedDiscount(null);
    if (item.promoReservationId) {
      if (delta < 0) removeFromCart(id);
      return;
    }
    setCart((curr) =>
      curr
        .map((item) =>
          item.id === id ? { ...item, quantity: Math.min(maxCartQuantity(item), Math.max(0, item.quantity + delta)) } : item
        )
        .filter((item) => item.quantity > 0)
    );
  };

  const removeFromCart = (id) => {
    const item = cart.find((cartItem) => cartItem.id === id);
    if (item?.promoReservationId) requestApi(`/api/promo-codes/reservations/${encodeURIComponent(item.promoReservationId)}/release`, { method: 'POST' })
      .catch((error) => setCartError(`The Promo Code reservation could not be released: ${error.message}`));
    setAppliedDiscount(null);
    setCart((curr) => curr.filter((cartItem) => cartItem.id !== id));
  };

  const handleLogin = (user) => {
    setAuth(user);
    setLoginAttempted(true);
    closeModal();
  };

  const handleGoogleSuccess = async (credentialResponse) => {
    if (!credentialResponse?.credential) {
      openModal('payment-error', { title: 'Sign-in issue', message: 'Google sign-in failed. Please try again.' });
      return;
    }

    try {
      const response = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ credential: credentialResponse.credential }),
      });
      const result = await parseJsonSafely(response);
      if (!response.ok) {
        throw new Error(
          result?.message ||
          (response.status >= 500
            ? 'The sign-in service is unavailable. Please try again after the server is restored.'
            : 'Google sign-in failed. Please try again.')
        );
      }
      if (!result?.user) throw new Error('The sign-in service returned an invalid response. Please try again.');
      if (result.requiresAdminVerification) {
        setAuth({ ...result.user, requiresAdminVerification: true });
        setLoginAttempted(true);
        openModal('admin-verification');
      } else {
        handleLogin(result.user);
      }
    } catch (error) {
      openModal('payment-error', {
        title: 'Sign-in issue',
        message: error instanceof TypeError
          ? 'Could not reach the sign-in service. Check that the API server and database are running.'
          : error.message || 'Google sign-in failed. Please try again.',
      });
    }
  };

  const verifyAdminPassword = async (password) => {
    try {
      const result = await requestApi('/api/auth/admin/verify', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setAuth(result.user);
      closeModal();
      navigate('/admin', { replace: true });
    } catch (error) {
      throw new Error(error.message === 'The admin password you entered is incorrect.'
        ? error.message
        : 'Admin verification could not be completed. Please try again.');
    }
  };

  const handleCheckoutClick = () => {
    if (!auth) {
      openModal('require-signin');
      return;
    }
    const promoItems = cart.filter((item) => item.promoReservationId);
    if (promoItems.length) {
      if (promoItems.length !== cart.length) {
        openModal('payment-error', { title: 'Separate Checkout Required', message: 'Promo Codes must be purchased separately from physical products.' });
        return;
      }
      navigate(`/products/promo-codes/payment/${encodeURIComponent(promoItems[0].promoReservationId)}`);
      return;
    }
    setCheckoutStep(cart.every((item) => item.discountOfferId) ? 3 : 1);
    navigate('/checkout');
  };

  const applyDiscountCode = async (code) => {
    const result = await requestApi('/api/discount-codes/validate', {
      method: 'POST',
      body: JSON.stringify({ code, items: cart }),
    });
    setAppliedDiscount({ code: result.code, discountAmount: Number(result.discountAmount), discountLabel: result.discountLabel, offerName: result.offerName });
    return result;
  };

  const saveOrderToAccount = async (razorpayId) => {
    const result = await requestApi('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        items: cart,
        address: cart.some((item) => !item.discountOfferId) ? address : undefined,
        service: selectedService,
        projectDescription: projectPreferences,
        discountCode: appliedDiscount?.code,
        razorpayId,
      }),
    });
    const savedOrder = normalizeOrderRecord(result.order);
    setOrders((current) => [savedOrder, ...current.filter((order) => order.id !== savedOrder.id)]);
    setAccountData((current) => {
      if (!current) return current;
      const dbOrders = [result.order, ...(current.orders || []).filter((order) => order.orderId !== result.order.orderId)];
      return {
        ...current,
        orders: dbOrders,
        stats: {
          totalOrders: dbOrders.length,
          totalItemsOrdered: dbOrders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0),
          totalSpent: dbOrders.reduce((sum, order) => sum + order.total, 0),
          customOrderCount: current.stats?.customOrderCount || 0,
        },
      };
    });
    if (result.notification) setNotifications((current) => [result.notification, ...current]);
    setCustomOrders((current) => current.map((order) =>
      cart.some((item) => item.customOrderId === String(order._id))
        ? { ...order, status: 'Ordered', orderedAt: new Date().toISOString() }
        : order
    ));
    return savedOrder;
  };

  const handlePlaceOrder = async () => {
    if (!auth) {
      openModal('require-signin');
      return;
    }

    let savedOrder;
    try {
      savedOrder = await saveOrderToAccount();
    } catch (error) {
      setAccountError(`This order could not sync to your account yet: ${error.message}`);
      return;
    }
    setCart([]);
    setCheckoutStep(4);
    navigate('/order-placed', { state: { order: savedOrder } });
  };

  const submitCustomOrder = async (event) => {
    event.preventDefault();
    const requestedItem = customItemName.trim();
    if (!requestedItem || submittingRequest) return;

    setSubmittingRequest(true);
    setCustomOrderError('');
    try {
      const result = await requestApi('/api/custom-orders', {
        method: 'POST',
        body: JSON.stringify({ requestedItem }),
      });
      setCustomOrders((current) => [
        result.customOrder,
        ...current.filter((item) => item._id !== result.customOrder._id),
      ]);
      setCustomItemName('');
    } catch (error) {
      setCustomOrderError(error.message);
    } finally {
      setSubmittingRequest(false);
    }
  };

  const orderAcceptedCustomItem = (customOrder) => {
    const item = {
      id: `custom-${customOrder._id}`,
      customOrderId: customOrder._id,
      name: customOrder.requestedItem,
      category: 'Custom Order',
      price: customOrder.price,
      image: null,
      description: 'Admin-approved custom Arduino project part.',
    };
    setCart((current) => {
      const existing = current.find((cartItem) => cartItem.id === item.id);
      return existing
        ? current.map((cartItem) => cartItem.id === item.id
          ? { ...cartItem, quantity: cartItem.quantity + 1 }
          : cartItem)
        : [...current, { ...item, quantity: 1 }];
    });
    setCheckoutStep(1);
    setSelectedService('parts');
    navigate('/checkout');
  };

  const acceptCustomOrder = (customOrder) => {
    openModal('confirm-custom-order', { customOrder });
  };

  const confirmAcceptCustomOrder = async () => {
    const customOrder = modal.props.customOrder;
    const price = Number(adminPrices[customOrder._id]);
    setAdminOrderError('');
    try {
      const result = await requestApi(`/api/admin/custom-orders/${customOrder._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Accepted', price }),
      });
      setAdminCustomOrders((current) => current.map((item) =>
        item._id === result.customOrder._id ? result.customOrder : item
      ));
      closeModal();
    } catch (error) {
      setAdminOrderError(error.message);
      closeModal();
    }
  };

  const rejectCustomOrder = async (customOrder) => {
    setAdminOrderError('');
    try {
      const result = await requestApi(`/api/admin/custom-orders/${customOrder._id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Rejected' }),
      });
      setAdminCustomOrders((current) => current.map((item) =>
        item._id === result.customOrder._id ? result.customOrder : item
      ));
    } catch (error) {
      setAdminOrderError(error.message);
    }
  };

  const saveAddress = async (newAddress) => {
    if (!auth) return false;
    setAddress(newAddress);
    try {
      const { address: savedAddress } = await requestApi('/api/account/address', {
        method: 'PUT',
        body: JSON.stringify({ address: newAddress }),
      });
      setSavedAddresses((current) => ({ ...current, [auth.email]: savedAddress }));
      setAddress(savedAddress);
      setAccountData((current) => current ? {
        ...current,
        profile: { ...current.profile, address: savedAddress },
      } : current);
      return true;
    } catch (error) {
      setAccountError(error.message);
      return false;
    }
  };

  const savePromoRecipientAddress = async (newAddress) => {
    if (!auth) return;
    const result = await requestApi('/api/account/recipient-addresses', {
      method: 'POST',
      body: JSON.stringify({ address: newAddress }),
    });
    setSavedAddresses((current) => ({
      ...current,
      [`${auth.email}::promo-recipient-addresses`]: result.recipientAddresses || [],
    }));
  };

  const saveAccountPhone = async (phoneNumber) => {
    const result = await requestApi('/api/account/settings', {
      method: 'PATCH',
      body: JSON.stringify({ phoneNumber }),
    });
    setAccountData((current) => current ? {
      ...current,
      profile: { ...current.profile, phoneNumber: result.phoneNumber },
    } : current);
    setAccountNotice('Your account settings have been updated.');
  };

  const markNotificationRead = async (notification) => {
    try {
      const result = await requestApi(`/api/notifications/${notification._id}/read`, { method: 'PATCH' });
      setNotifications((current) => current.map((item) =>
        item._id === notification._id ? result.notification : item
      ));
      setAccountData((current) => current ? {
        ...current,
        notifications: current.notifications.map((item) =>
          item._id === notification._id ? result.notification : item
        ),
      } : current);
    } catch (error) {
      setAccountError(error.message);
    }
  };

  useEffect(() => {
    if (!auth || giftPopupNotification) return;
    const giftNotification = notifications.find((item) => item.type === 'promo_gift_received' && !item.read);
    if (!giftNotification) return;
    setGiftPopupNotification(giftNotification);
    markNotificationRead(giftNotification);
  }, [auth, notifications, giftPopupNotification]);

  const handleSignOut = async () => {
    try {
      await requestApi('/api/auth/logout', { method: 'POST' });
      setAuth(null);
      setAiOpenSignal(0);
      setAccountData(null);
      setCustomOrders([]);
      setNotifications([]);
      setGiftPopupNotification(null);
      setAdminCustomOrders([]);
      setRefunds([]);
      setAdminRefunds([]);
      setCart([]);
      setOrders([]);
      setWishlist([]);
      setSavedAddresses({});
      setBrowsingHistory([]);
      setAddress({ ...initialAddress });
      setSelectedService('parts');
      setProjectPreferences('');
      setCheckoutStep(1);
      setAccountError('');
      closeModal();
      navigate('/', { replace: true });
    } catch (error) {
      setAccountError(`Could not sign out: ${error.message}`);
    }
  };

  const handleRefundSubmitted = (refund) => {
    setRefunds((current) => [refund, ...current.filter((item) => item._id !== refund._id)]);
    const updateOrder = (order) => (order.orderId || order.id) === refund.orderId
      ? { ...order, refundEligible: false, refundCase: { _id: refund._id, refundCaseId: refund.refundCaseId, status: refund.status, refundAmountPaise: refund.refundAmountPaise } }
      : order;
    setOrders((current) => current.map(updateOrder));
    setAccountData((current) => current ? { ...current, orders: current.orders.map(updateOrder) } : current);
  };

  const handlePromoCodePurchased = (order, reservationId) => {
    const savedOrder = normalizeOrderRecord({ ...order, refundEligible: false, cancelEligible: false, orderType: order.orderType || 'PROMO_CODE' });
    setOrders((current) => [savedOrder, ...current.filter((item) => item.id !== savedOrder.id)]);
    setAccountData((current) => current ? {
      ...current,
      orders: [{ ...order, refundEligible: false, cancelEligible: false, orderType: order.orderType || 'PROMO_CODE' }, ...(current.orders || []).filter((item) => item.orderId !== order.orderId)],
      stats: { ...current.stats, totalOrders: new Set([order.orderId, ...(current.orders || []).map((item) => item.orderId)]).size },
    } : current);
    setCart((current) => current.filter((item) => item.promoReservationId !== reservationId));
    return savedOrder;
  };

  const cancelWalletOrder = async (order, reason, idempotencyKey) => {
    const orderId = order.orderId || order.id;
    const result = await requestApi(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason, idempotencyKey }),
    });
    const normalized = normalizeOrderRecord(result.order);
    const updateOrder = (current) => (current.orderId || current.id) === orderId
      ? { ...current, ...normalized, cancelEligible: false, refundEligible: false }
      : current;
    setOrders((current) => current.map(updateOrder));
    setAccountData((current) => current ? { ...current, orders: current.orders.map(updateOrder) } : current);
    openModal('order-cancel-success', { order: normalized, cancellation: result.cancellation, wallet: result.wallet });
  };

  const handleAdminRefundUpdated = (refund) => {
    setAdminRefunds((current) => current.map((item) => item._id === refund._id ? refund : item));
  };

  const payWithWallet = async (pin) => {
    const projectDescription = projectPreferences || '';
    const idempotencyKey = walletPaymentKeyRef.current || (globalThis.crypto?.randomUUID?.() || `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    walletPaymentKeyRef.current = idempotencyKey;
    const result = await requestApi('/api/wallet/pay', {
      method: 'POST',
      body: JSON.stringify({ items: cart, address: cart.some((item) => !item.discountOfferId) ? address : undefined, service: selectedService, projectDescription, pin, idempotencyKey, discountCode: appliedDiscount?.code }),
    });
    const paidOrder = { ...normalizeOrderRecord(result.order), paymentMethod: 'Wallet', walletBalanceAfter: result.wallet.balance };
    setOrders((current) => [paidOrder, ...current.filter((order) => order.id !== paidOrder.id)]);
    setAccountData((current) => current ? {
      ...current,
      orders: [paidOrder, ...(current.orders || []).filter((order) => order.orderId !== paidOrder.id)],
    } : current);
    walletPaymentKeyRef.current = '';
    setCart([]);
    setAppliedDiscount(null);
    closeModal();
    navigate('/order-placed', { state: { order: paidOrder } });
  };

  const handleRazorpay = async () => {
    if (!window.Razorpay) {
      openModal('payment-error', { message: 'Razorpay checkout could not load. Please retry.' });
      return;
    }

    const amount = Math.round(grandTotal * 100);
    const options = {
      key: 'rzp_test_dummykey',
      amount,
      currency: 'INR',
      name: 'Innovation Labs',
      description: 'Project Purchase',
      handler: async function (response) {
        let savedOrder;
        try {
          savedOrder = await saveOrderToAccount(response.razorpay_payment_id);
        } catch (error) {
          setAccountError(`Payment returned, but inventory could not be reserved: ${error.message}`);
          openModal('payment-error', {
            title: 'Order could not be completed',
            message: `${error.message} Your cart has been kept. Check My Orders before retrying payment.`,
          });
          return;
        }
        setCart([]);
        setAppliedDiscount(null);
        navigate('/order-placed', { state: { order: savedOrder } });
      },
      prefill: {
        name: auth?.name || '',
        email: auth?.email || '',
      },
      theme: { color: '#00d1ff' },
      modal: {
        ondismiss: () => {
          openModal('payment-error', { message: 'Payment was cancelled. Please try again.' });
        },
      },
    };

    const razorpay = new window.Razorpay(options);
    razorpay.open();
  };

  return (
    <>
      <Header
        auth={auth}
        cartCount={cartCount}
        onSignIn={() => openModal('google-login')}
        onAccount={() => navigate('/account')}
        onWallet={() => openWalletUnlock()}
        onOpenCart={() => navigate('/cart')}
      />
      {!auth && !authLoading && accountError && <div className="container"><div className="alert-box" role="alert">{accountError} <button type="button" className="secondary-btn small" onClick={() => window.location.reload()}>Retry</button></div></div>}

      <Routes>
        <Route path="/" element={<HomePage
          catalog={catalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          browsingHistory={browsingHistory}
          onTrackViewed={trackProductView}
          onShopNow={() => navigate('/products')}
          onBuild={openAIBuilder}
          onExploreAI={() => navigate('/plans')}
        />} />
        <Route path="/history" element={<HistoryPage
          history={browsingHistory}
          catalog={catalog}
          loading={browsingHistoryLoading}
          error={browsingHistoryError}
          onRemove={removeProductFromHistory}
          onClear={clearBrowsingHistory}
        />} />
        <Route path="/plans" element={<PlansPage auth={auth} onSignIn={() => openModal('google-login')} onSubscriptionChange={() => requestApi('/api/subscription').then(setSubscriptionData).catch((error) => setAccountError(`Subscription details could not be refreshed: ${error.message}`))} />} />
        <Route path="/plans/ai-trial/:plan" element={<AITrialActivationPage auth={auth} onSignIn={() => openModal('google-login')} />} />
        <Route path="/products/:productId" element={<ProductDetailsPage auth={auth} onSignIn={() => openModal('google-login')} onAddToCart={handleAddToCart} onAddWishlistItem={addWishlistItem} onTrackViewed={trackProductView} wishlist={wishlist} cart={cart} />} />
        <Route path="/products" element={<ProductsPage cart={cart} wishlist={wishlist} auth={auth} onSignIn={() => openModal('google-login')} onTrackViewed={trackProductView} onAddToCart={handleAddToCart} onAddWishlistItem={addWishlistItem} onQty={updateQuantity} onAddPromoToCart={handleAddPromoToCart} />} />
            <Route path="/discount-codes" element={authLoading ? <AccountLoadingPage /> : auth ? <ProductsPage initialCategory="Discount Promo Codes" cart={cart} wishlist={wishlist} auth={auth} onSignIn={() => openModal('google-login')} onTrackViewed={trackProductView} onAddToCart={handleAddToCart} onAddWishlistItem={addWishlistItem} onQty={updateQuantity} onAddPromoToCart={handleAddPromoToCart} /> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/products/promo-codes/payment/:reservationId" element={authLoading ? <AccountLoadingPage /> : auth ? <PromoCodePaymentPage auth={auth} address={address} setAddress={setAddress} savedAddresses={savedAddresses} saveAddress={saveAddress} savePromoRecipientAddress={savePromoRecipientAddress} nextPromoReservationId={cart.filter((item) => item.promoReservationId)[1]?.promoReservationId} onPurchased={handlePromoCodePurchased} /> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/cart" element={<CartPage cart={cart} cartError={cartError} appliedDiscount={appliedDiscount} onApplyDiscount={applyDiscountCode} onDiscountValidated={(result) => setAppliedDiscount({ code: result.code, discountAmount: Number(result.discountAmount), discountLabel: result.discountLabel, offerName: result.offerName })} onRemoveDiscount={() => setAppliedDiscount(null)} onRemove={removeFromCart} onQty={updateQuantity} onMoveToWishlist={moveCartItemToWishlist} onCheckout={handleCheckoutClick} />} />
        <Route path="/custom-order" element={<CustomOrdersPage
          auth={auth}
          customOrders={customOrders}
          notifications={notifications}
          error={customOrderError}
          itemName={customItemName}
          submitting={submittingRequest}
          setItemName={setCustomItemName}
          onSubmit={submitCustomOrder}
          onOrder={orderAcceptedCustomItem}
        />} />
        <Route path="/admin/custom-requests" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/custom-requests"><AdminCustomRequestsPage
          auth={auth}
          customOrders={adminCustomOrders}
          error={adminOrderError}
          prices={adminPrices}
          setPrices={setAdminPrices}
          onAccept={acceptCustomOrder}
          onReject={rejectCustomOrder}
        /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin"><AdminDashboardPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/orders" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/orders"><AdminOrdersPageV2 auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/orders/:orderId" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/orders"><AdminOrderDetailPage auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/rewards" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/rewards"><AdminRewardsPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/product-reviews" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/product-reviews"><AdminProductReviewsPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/discount-codes" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/discount-codes"><AdminDiscountCodesPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/scratch-cards" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/scratch-cards"><AdminScratchCardsPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/invoices" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/invoices"><AdminInvoicesPage /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/inventory" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/inventory"><InventoryPage auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/settings" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/settings"><AdminSettingsPage auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/credit-purchases" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/credit-purchases"><AdminCreditPurchasesPage auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/promo-codes" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/promo-codes"><AdminPromoCodesPage auth={auth} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/wallet" element={<WalletPage auth={auth} accessVersion={walletAccessVersion} onRequestUnlock={() => openWalletUnlock(true)} />} />
        <Route path="/refund/:orderId" element={authLoading ? <AccountLoadingPage /> : auth ? <RefundRequestPage auth={auth} onSubmitted={handleRefundSubmitted} /> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/refunds/:id" element={<RefundStatusPage auth={auth} />} />
        <Route path="/admin/refunds" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/refunds"><AdminRefundsPage auth={auth} refunds={adminRefunds} error={adminOrderError} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/admin/refunds/:id" element={authLoading ? <AccountLoadingPage /> : auth?.isAdmin ? <AdminWorkspaceLayout currentPath="/admin/refunds"><AdminRefundDetailPage auth={auth} onUpdated={handleAdminRefundUpdated} /></AdminWorkspaceLayout> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/account/ai-credits/add" element={authLoading ? <AccountLoadingPage /> : auth ? <AddCreditsPage /> : <SignInRequiredPage onSignIn={() => openModal('google-login')} />} />
        <Route path="/account/:section?" element={authLoading ? (
          <AccountLoadingPage />
        ) : auth ? (
          <AccountPage
            user={auth}
            accountData={accountData}
            wishlist={wishlist}
            onAddWishlistItem={addWishlistItem}
            onRemoveWishlistItem={removeWishlistItem}
            onAddWishlistPromoToCart={addWishlistPromoToCart}
            onAddToCart={handleAddToCart}
            onAddDiscountCodeToCart={() => navigate('/discount-codes')}
            orders={orders.filter((order) => order.email === auth.email)}
            customOrders={customOrders}
            notifications={notifications}
            address={accountData?.profile?.address || initialAddress}
            loading={accountLoading}
            error={accountError}
            notice={accountNotice}
            onSaveAddress={saveAddress}
            onSavePhone={saveAccountPhone}
            onMarkRead={markNotificationRead}
            onOrderCustomItem={orderAcceptedCustomItem}
            onSignOut={handleSignOut}
            onCancelOrder={(order) => openModal('order-cancel', { order })}
          />
        ) : (
          <SignInRequiredPage onSignIn={() => openModal('google-login')} />
        )} />
        <Route path="/checkout" element={<CheckoutPage
          auth={auth}
          cart={cart}
          selectedService={selectedService}
          setSelectedService={setSelectedService}
          projectPreferences={projectPreferences}
          setProjectPreferences={setProjectPreferences}
          address={address}
          setAddress={setAddress}
          saveAddress={saveAddress}
          checkoutStep={checkoutStep}
          setCheckoutStep={setCheckoutStep}
          onOpenProjectModal={openProjectPreferencesModal}
          onPay={handleRazorpay}
          onWalletPay={() => openModal('wallet-payment-pin')}
          paymentTotal={grandTotal}
          appliedDiscount={appliedDiscount}
          codingCharge={codingCharge}
          buildingCharge={buildingCharge}
          deliveryCharge={deliveryCharge}
          subtotal={subtotal}
          handlePlaceOrder={handlePlaceOrder}
          onLogin={() => openModal('google-login')}
          savedAddresses={savedAddresses}
          authEmail={auth?.email}
        />} />
        <Route path="/orders" element={authLoading ? <AccountLoadingPage /> : (
          <OrdersPage
            orders={orders}
            auth={auth}
            loading={accountLoading}
            error={accountError}
            onSignIn={() => openModal('google-login')}
            onCancelOrder={(order) => openModal('order-cancel', { order })}
          />
        )} />
        <Route path="/order-placed" element={<OrderPlacedPage order={location.state?.order || orders[0]} />} />
      </Routes>

      <SiteFooter />

      {auth && (
        <AIAssistant
          auth={auth}
          plan={subscriptionData?.current?.plan || 'Starter'}
          cart={cart}
          service={selectedService}
          onAddComponentsToCart={addProjectComponentsToCart}
          onPrepareCheckout={prepareAiCheckout}
          onOpenCustomBuilding={openCustomBuilding}
          onNavigate={navigate}
          openSignal={aiOpenSignal}
        />
      )}

      {modal.open && modal.kind !== 'wallet-access-pin' && (
        <Modal onClose={closeModal}>
          {modal.kind === 'google-login' && (
            <GoogleLoginModal
              onSuccess={handleGoogleSuccess}
              onClose={closeModal}
            />
          )}
          {modal.kind === 'admin-verification' && (
            <AdminVerificationModal onCancel={() => {
              closeModal();
              if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) navigate('/account', { replace: true });
            }} onVerify={verifyAdminPassword} />
          )}

          {modal.kind === 'require-signin' && (
            <RequireSignInModal onClose={closeModal} onSignIn={() => openModal('google-login')} />
          )}

          {modal.kind === 'signin-reminder' && (
            <SignInReminderModal
              repeat={modal.props.repeat}
              onClose={closeModal}
              onSignIn={() => openModal('google-login')}
            />
          )}

          {modal.kind === 'project-preferences' && (
            <ProjectPreferencesModal
              value={modal.props.value}
              onClose={closeModal}
              onSave={(value) => {
                modal.props.onSave(value);
                closeModal();
              }}
            />
          )}

          {modal.kind === 'payment-error' && (
            <PaymentErrorModal message={modal.props.message} onClose={closeModal} />
          )}
          {modal.kind === 'confirm-custom-order' && (
            <ConfirmCustomOrderModal
              itemName={modal.props.customOrder.requestedItem}
              onConfirm={confirmAcceptCustomOrder}
              onCancel={closeModal}
            />
          )}
          {modal.kind === 'wallet-payment-pin' && <WalletPinModal onCancel={closeModal} onSubmit={payWithWallet} />}
          {modal.kind === 'order-cancel' && <OrderCancellationModal order={modal.props.order} onCancel={closeModal} onConfirm={cancelWalletOrder} />}
          {modal.kind === 'order-cancel-success' && <OrderCancellationSuccessModal {...modal.props} onViewWallet={() => { closeModal(); navigate('/wallet'); }} onViewOrder={() => { const order = modal.props.order; closeModal(); navigate('/order-placed', { state: { order } }); }} />}
        </Modal>
      )}
      {modal.open && modal.kind === 'wallet-access-pin' && (
        <WalletAccessPinModal
          mode={modal.props.mode}
          checking={modal.props.checking}
          onCancel={cancelWalletUnlock}
          onSubmit={submitWalletPin}
        />
      )}
      {giftPopupNotification && <PromoGiftReceivedModal notification={giftPopupNotification} onClose={() => setGiftPopupNotification(null)} onView={() => { setGiftPopupNotification(null); navigate('/wallet', { state: { openPromoTab: true } }); }} />}
    </>
  );
}

function Header({ auth, cartCount, onSignIn, onAccount, onWallet, onOpenCart }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  const closeMobileMenu = () => setMobileMenuOpen(false);
  const openWallet = () => {
    closeMobileMenu();
    onWallet();
  };
  const openCart = () => {
    closeMobileMenu();
    onOpenCart();
  };
  const openAccount = () => {
    closeMobileMenu();
    onAccount();
  };
  const signIn = () => {
    closeMobileMenu();
    onSignIn();
  };

  return (
    <header className="topbar">
      <div className="container nav-wrap">
        <Link className="brand" to="/">
          <span className="brand-mark">I</span> Innovation Labs
        </Link>
        <button
          className="mobile-nav-toggle"
          type="button"
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-primary-navigation"
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{mobileMenuOpen ? '×' : '☰'}</span>
        </button>

        <nav className="nav">
          <Link to="/">Home</Link>
          <Link to="/products">Products</Link>
          <Link to="/plans">Plans &amp; AI</Link>
          {auth && <Link to="/custom-order">Custom Order</Link>}
          {auth && <button className="nav-link-button" onClick={onWallet}>Wallet</button>}
          {auth?.isAdmin && <Link to="/admin">Admin</Link>}
          {auth?.isAdmin && <Link to="/admin/promo-codes">Promo Codes</Link>}
          {auth?.isAdmin && <Link to="/admin/refunds">Refunds</Link>}
          <Link to="/orders">My Orders</Link>
        </nav>

        <div className="nav-actions">
          <button className="cart-button" onClick={onOpenCart}>
            Cart <span>{cartCount}</span>
          </button>
          {auth ? (
            <button className="account-button primary-btn small" onClick={onAccount} title="Open account">
              <span aria-hidden="true">◉</span> Hi, {auth.name.split(' ')[0]}
            </button>
          ) : (
            <button className="primary-btn small" onClick={onSignIn}>Sign In</button>
          )}
        </div>
      </div>
      {mobileMenuOpen && <button className="mobile-nav-backdrop" type="button" aria-label="Close navigation menu" onClick={closeMobileMenu} />}
      <nav className={`mobile-primary-navigation ${mobileMenuOpen ? 'is-open' : ''}`} id="mobile-primary-navigation" aria-label="Main navigation" aria-hidden={!mobileMenuOpen}>
          <Link to="/" onClick={closeMobileMenu}>Home</Link>
          <Link to="/products" onClick={closeMobileMenu}>Products</Link>
          <Link to="/plans" onClick={closeMobileMenu}>Plans &amp; AI</Link>
          {auth && <Link to="/custom-order" onClick={closeMobileMenu}>Custom Order</Link>}
          {auth && <button type="button" onClick={openWallet}>Wallet</button>}
          {auth?.isAdmin && <Link to="/admin" onClick={closeMobileMenu}>Admin</Link>}
          {auth?.isAdmin && <Link to="/admin/promo-codes" onClick={closeMobileMenu}>Promo Codes</Link>}
          {auth?.isAdmin && <Link to="/admin/refunds" onClick={closeMobileMenu}>Refunds</Link>}
          <Link to="/orders" onClick={closeMobileMenu}>My Orders</Link>
          <button type="button" onClick={openCart}>Cart <span>{cartCount}</span></button>
          {auth
            ? <button type="button" onClick={openAccount}><span aria-hidden="true">◉</span> Account</button>
            : <button type="button" onClick={signIn}>Sign In</button>}
      </nav>
    </header>
  );
}

function SiteFooter() {
  const quickLinks = [
    { label: 'Home', to: '/' },
    { label: 'Products', to: '/products' },
    { label: 'History', to: '/history' },
    { label: 'Plans & AI', to: '/plans' },
    { label: 'Custom Order', to: '/custom-order' },
    { label: 'Wallet', to: '/wallet' },
    { label: 'My Orders', to: '/orders' },
  ];
  const policyLinks = [
    { label: 'Privacy Policy', href: FOOTER_POLICY_LINKS.privacy },
    { label: 'Terms & Conditions', href: FOOTER_POLICY_LINKS.terms },
    { label: 'Refund Policy', href: FOOTER_POLICY_LINKS.refund },
    { label: 'Shipping Policy', href: FOOTER_POLICY_LINKS.shipping },
    { label: 'Contact Us', href: FOOTER_POLICY_LINKS.contact },
  ].filter((item) => item.href.trim());
  const socialLinks = Object.entries(SOCIAL_LINKS)
    .map(([key, href]) => ({
      ...socialPlatforms[key],
      href: typeof href === 'string' && /^https?:\/\//i.test(href.trim()) ? href.trim() : '',
    }));

  return <footer className="site-footer">
    <div className="site-footer-container">
      <div className="site-footer-main">
        <Link className="site-footer-brand" to="/">
          <span className="site-footer-mark" aria-hidden="true">I</span>
          <span><strong>Innovation Labs</strong><small>Build what comes next.</small></span>
        </Link>
        <nav className="site-footer-links" aria-label="Quick links">
          <h2>Quick Links</h2>
          {quickLinks.map((item) => <Link key={item.to} to={item.to}>{item.label}</Link>)}
        </nav>
        <section className="site-footer-social" aria-labelledby="site-footer-social-heading">
          <h2 id="site-footer-social-heading">Follow Us</h2>
          <div className="site-footer-social-list">{socialLinks.map(({ label, icon, href }) => href ? <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Follow Innovation Labs on ${label}`} title={label}>
            <svg viewBox="0 0 24 24" role="img" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
            <span>{label}</span>
          </a> : <span className="site-footer-social-unavailable" key={label} aria-label={`${label} link not configured`} title={`${label} link not configured`} aria-disabled="true">
            <svg viewBox="0 0 24 24" role="img" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
            <span>{label}</span>
          </span>)}</div>
        </section>
      </div>
      {(policyLinks.length > 0) && <nav className="site-footer-policies" aria-label="Policies and contact">{policyLinks.map((item) => <a key={item.label} href={item.href}>{item.label}</a>)}</nav>}
      <div className="site-footer-bottom">
        <p>© {new Date().getFullYear()} Innovation Labs. All Rights Reserved.</p>
        <p>Designed &amp; Developed by Innovation Labs.</p>
      </div>
    </div>
  </footer>;
}

function HomePage({ catalog, catalogLoading, catalogError, browsingHistory, onTrackViewed, onShopNow, onBuild, onExploreAI }) {
  const navigate = useNavigate();
  const featuredProducts = useMemo(() => {
    const availableProducts = catalog.filter((product) => product.status !== 'Out of Stock'
      && product.status !== 'Unavailable'
      && !(product.inventoryProduct && Number.isFinite(Number(product.stock)) && Number(product.stock) < 1)
      && product.available !== false);
    const productsById = new Map(availableProducts.map((product) => [String(product.id), product]));
    const selected = [];
    const add = (product) => {
      if (product && !selected.some((item) => String(item.id) === String(product.id))) selected.push(product);
    };
    [...browsingHistory]
      .sort((left, right) => new Date(right.viewedAt) - new Date(left.viewedAt))
      .forEach((entry) => add(productsById.get(String(entry.productId))));
    availableProducts.forEach(add);
    return selected.slice(0, 3);
  }, [catalog, browsingHistory]);
  const categories = [...new Set(catalog.map((product) => product.category).filter(Boolean))].slice(0, 6);

  return (
    <main className="home-page">
      <section className="home-hero">
        <div className="home-container home-hero-layout">
          <div className="home-hero-copy">
            <span className="home-kicker"><span /> Innovation Labs</span>
            <p className="home-overline">Hardware · Intelligence · Imagination</p>
            <h1>Imagine it.<br />Engineer it.<br /><em>Bring it to life.</em></h1>
            <p className="home-intro">Discover innovative electronics, explore intelligent AI-powered tools, and turn your next big idea into a real-world creation.</p>
            <div className="home-actions home-hero-actions">
              <button className="home-primary-btn" onClick={onShopNow}>Explore Products <span aria-hidden="true">↗</span></button>
              <button className="home-secondary-btn" onClick={onBuild}>Build Your Own Project</button>
              <button className="home-text-btn" onClick={onExploreAI}>Explore AI <span aria-hidden="true">↗</span></button>
            </div>
            <div className="home-proof"><span>IDEAS INTO ENGINEERING</span><span>One connected innovation platform</span></div>
          </div>
          <div className="home-hero-visual" aria-label="Electronics development board and project signals">
            <div className="home-visual-grid" />
            <div className="home-art-orbit home-art-orbit-one" />
            <div className="home-art-orbit home-art-orbit-two" />
            <figure className="home-art-photo">
              <img src={productImages.board} alt="Electronics development board on a workbench" onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = fallbackProductImage;
              }} />
              <figcaption><span>FIELD NOTES / 001</span><strong>Ideas become systems.</strong></figcaption>
            </figure>
            <div className="home-float-card home-float-signal"><span className="home-signal-dot" /> SYSTEM READY <strong>3.3V <small>CORE</small></strong></div>
            <div className="home-float-card home-float-index"><span>IL / LAB</span><strong>001</strong><small>ENGINEERING<br />THE NEXT IDEA</small></div>
            <div className="home-visual-caption"><span>◈</span> COMPONENTS FOR WHAT'S NEXT</div>
          </div>
        </div>
      </section>

      <section className="home-discover-section">
        <div className="home-container home-discover-layout">
          <div className="home-discover-intro">
            <span className="home-section-index">01 / THE INNOVATION LOOP</span>
            <h2>Your ideas deserve<br />to become reality.</h2>
            <p>From the first spark of inspiration to a working prototype, find the parts, guidance, and expertise to move forward.</p>
          </div>
          <div className="home-discover-grid">
            <Link to="/products" className="home-discover-card home-discover-components">
              <span className="home-discover-number">01</span><span className="home-discover-symbol" aria-hidden="true">⌘</span>
              <div><h3>Discover technology</h3><p>Explore electronic components and ready-to-build project essentials.</p></div><span className="home-discover-link">Explore the catalogue ↗</span>
            </Link>
            <Link to="/custom-order" className="home-discover-card home-discover-custom">
              <span className="home-discover-number">02</span><span className="home-discover-symbol" aria-hidden="true">⌁</span>
              <div><h3>Build something unique</h3><p>Shape a custom-built project around your requirements and ambition.</p></div><span className="home-discover-link">Start a custom order ↗</span>
            </Link>
            <button type="button" className="home-discover-card home-discover-ai" onClick={onExploreAI}>
              <span className="home-discover-number">03</span><span className="home-discover-symbol" aria-hidden="true">✳</span>
              <div><h3>Create with AI</h3><p>Turn a project idea into a practical plan with Innovation Labs AI tools.</p></div><span className="home-discover-link">Explore AI tools ↗</span>
            </button>
          </div>
        </div>
      </section>

      <section className="home-featured-section">
        <div className="home-container">
          <div className="home-section-heading home-section-heading-row">
            <div><span className="home-section-index">02 / PICK UP WHERE YOU LEFT OFF</span><h2>Featured for you.</h2></div>
            <p>Based on your recent product discoveries, with a few ideas to keep you exploring.</p>
          </div>
          {catalogError && <div className="alert-box" role="alert">{catalogError}</div>}
          <div className="home-product-grid">
            {catalogLoading ? [0, 1, 2].map((index) => <article className="home-product-card home-product-skeleton" key={`skeleton-${index}`} aria-hidden="true"><div className="home-product-image" /><div className="home-product-content"><span /><strong /><p /><div /></div></article>)
              : featuredProducts.map((product, index) => <article
                className="home-product-card"
                key={product.id}
                role="link"
                tabIndex={0}
                aria-label={`View ${product.name}`}
                onClick={() => navigate(`/products/${encodeURIComponent(product.id)}`)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    navigate(`/products/${encodeURIComponent(product.id)}`);
                  }
                }}
              >
                <div className="home-product-image"><img src={historyProductImage(product)} alt={product.name} loading="lazy" onError={(event) => {
                  event.currentTarget.onerror = null;
                  event.currentTarget.src = fallbackProductImage;
                }} /><span>{product.category}</span><b aria-hidden="true">↗</b></div>
                <div className="home-product-content">
                  <span className="home-product-category">{product.category}</span>
                  <h3>{product.name}</h3>
                  <p>{product.description}</p>
                  <div className="home-product-bottom"><strong className="home-product-price">{product.price != null ? `₹${Number(product.price).toLocaleString('en-IN')}` : 'View details'}</strong><span className={`home-stock-label ${product.status === 'Out of Stock' ? 'is-unavailable' : ''}`}>{product.status || 'In Stock'}</span></div>
                  <button type="button" className="home-view-btn" onClick={(event) => { event.stopPropagation(); navigate(`/products/${encodeURIComponent(product.id)}`); }}>View Product <span aria-hidden="true">↗</span></button>
                </div>
              </article>)}
          </div>
          {!catalogLoading && !catalogError && !featuredProducts.length && <div className="home-empty-catalog"><h3>New discoveries are on the way.</h3><p>Explore the catalogue to see what is available today.</p></div>}
          <div className="home-all-products"><button className="home-all-products-btn" onClick={onShopNow}>Explore the full catalogue <span aria-hidden="true">→</span></button></div>
        </div>
      </section>

      <section className="home-category-section">
        <div className="home-container home-category-layout">
          <div className="home-category-intro"><span className="home-section-index">03 / EXPLORE THE COLLECTION</span><h2>Start with the right building blocks.</h2><p>Browse real categories from the Innovation Labs catalogue.</p></div>
          <div className="home-category-grid">
            {categories.map((category, index) => <Link to={`/products?category=${encodeURIComponent(category)}`} className={`home-category home-category-art home-category-art-${index % 3}`} key={category}>
              <span className="home-category-art-image"><img src={historyProductImage(catalog.find((product) => product.category === category))} alt="" loading="lazy" /></span>
              <span className="home-category-art-text"><small>COMPONENT COLLECTION / 0{index + 1}</small><strong>{category}</strong><b>Explore collection <span aria-hidden="true">↗</span></b></span>
            </Link>)}
          </div>
          {catalogLoading && <div className="home-category-loading" role="status">Loading catalogue categories…</div>}
        </div>
      </section>

      <section className="home-process-section">
        <div className="home-container">
          <div className="home-section-heading home-section-heading-row">
            <div><span className="home-section-index">04 / FROM IDEA TO CREATION</span><h2>Make the next step real.</h2></div>
            <p>A clearer path from the thought in your head to the project on your workbench.</p>
          </div>
          <div className="home-process-grid">
            <article className="home-process-step"><span className="home-process-number">01</span><span className="home-process-icon">⌕</span><div><h3>Discover an idea</h3><p>Explore components and project essentials to find a starting point.</p></div></article>
            <article className="home-process-step"><span className="home-process-number">02</span><span className="home-process-icon">⌘</span><div><h3>Choose your approach</h3><p>Select the parts you need, or request a custom build for your idea.</p></div></article>
            <article className="home-process-step"><span className="home-process-number">03</span><span className="home-process-icon">✳</span><div><h3>Create and test</h3><p>Bring the pieces together, test your prototype, and keep iterating.</p></div></article>
          </div>
        </div>
      </section>

      <section className="home-custom-spotlight">
        <div className="home-container home-custom-spotlight-inner">
          <div className="home-custom-visual" aria-hidden="true"><div className="home-custom-orbit" /><div className="home-custom-chip"><span>IL / CUSTOM LAB</span><strong>IDEA → BUILD</strong><i /><i /><i /><i /></div><span className="home-custom-visual-note">MADE FOR THE UNCOMMON</span></div>
          <div className="home-custom-copy"><span className="home-section-index">05 / CUSTOM PROJECT SPOTLIGHT</span><h2>Have an idea nobody has built yet?</h2><p>Tell us what you imagine, choose your requirements, and explore a custom technology solution made around your project.</p><Link className="home-primary-btn" to="/custom-order">Start Custom Order <span aria-hidden="true">↗</span></Link></div>
        </div>
      </section>

      <section className="home-ai-showcase">
        <div className="home-container home-ai-layout">
          <div className="home-ai-copy"><span className="home-section-index">06 / INNOVATION, WITH INTELLIGENCE</span><h2>From a spark to a smarter build.</h2><p>Describe the electronics project you have in mind. Innovation Labs AI can recommend real catalogue components, estimate their current cost, and prepare a custom-building brief.</p><div className="home-ai-actions"><button className="home-primary-btn" onClick={onBuild}>Open AI Project Builder <span aria-hidden="true">↗</span></button><button className="home-secondary-btn" onClick={onExploreAI}>Explore plans &amp; AI</button></div><small>Features and access depend on your account plan.</small></div>
          <div className="home-ai-preview" aria-label="Illustration of the existing AI Project Builder">
            <div className="home-ai-preview-top"><span><i /> INNOVATION LABS / PROJECT BUILDER</span><b>● ● ●</b></div>
            <div className="home-ai-preview-message"><span>YOUR IDEA</span><p>Build a compact plant monitor for my desk.</p></div>
            <div className="home-ai-preview-response"><span><i /> PROJECT PLAN</span><strong>Smart Plant Monitor</strong><p>Review suggested components, availability, and an estimated subtotal.</p><div><b>Sensor</b><b>Controller</b><b>Display</b></div></div>
            <div className="home-ai-preview-input"><span>Describe an electronics project…</span><b>↑</b></div>
            <span className="home-ai-preview-orbit" aria-hidden="true" />
          </div>
        </div>
      </section>

      <section className="home-final-section">
        <div className="home-container home-final-inner"><span className="home-section-index">07 / WHAT WILL YOU MAKE?</span><div><h2>Your next big idea starts here.</h2><p>Explore the components, tools, and custom solutions that will help you bring it to life.</p></div><div className="home-final-actions"><button className="home-final-btn" onClick={onShopNow}>Explore Products <span aria-hidden="true">↗</span></button><button className="home-secondary-btn" onClick={onBuild}>Start Building</button></div></div>
      </section>
    </main>
  );
}

function HistoryPage({ history, catalog, loading, error, onRemove, onClear }) {
  const navigate = useNavigate();
  const catalogById = new Map(catalog.map((product) => [String(product.id), product]));
  const records = [...history].sort((left, right) => new Date(right.viewedAt) - new Date(left.viewedAt));
  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  return <main className="page-shell browsing-history-page"><div className="container">
    <div className="browsing-history-heading"><div><span className="eyebrow">YOUR PERSONAL PRODUCT JOURNAL</span><h1>Your Discovery Journey</h1><p>Pick up where you left off. Every project begins with an idea.</p></div>
      {!!records.length && <button type="button" className="secondary-btn" onClick={() => {
        if (window.confirm('Clear all products from your browsing history? This will not remove any products from the catalogue.')) onClear();
      }}>Clear History</button>}
    </div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {loading ? <div className="history-product-grid" aria-label="Loading browsing history">{[0, 1, 2].map((index) => <div className="history-product-card history-skeleton" key={index} aria-hidden="true"><div /><span /><b /><small /></div>)}</div>
      : records.length ? <div className="history-product-grid">{records.map((record) => {
        const product = catalogById.get(String(record.productId)) || record.product || {
          id: record.productId,
          name: record.productName || 'Unavailable product',
          category: 'Unavailable',
          status: 'Unavailable',
          available: false,
          price: null,
        };
        const unavailable = product.available === false || product.status === 'Unavailable';
        const viewedDate = new Date(record.viewedAt);
        return <article className={`history-product-card ${unavailable ? 'is-unavailable' : ''}`} key={record.productId}>
          {unavailable ? <div className="history-product-image" aria-label={`${product.name} is unavailable`}>
            <img src={fallbackProductImage} alt={product.name} loading="lazy" />
            <span>NO LONGER AVAILABLE</span>
          </div> : <Link className="history-product-image" to={`/products/${encodeURIComponent(record.productId)}`} aria-label={`Open ${product.name}`}>
            <img src={historyProductImage(product)} alt={product.name} loading="lazy" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} />
          </Link>}
          <div className="history-product-content"><span className="home-product-category">{product.category || 'Product'}</span><h2>{product.name}</h2>
            <strong>{product.price != null ? `₹${Number(product.price).toLocaleString('en-IN')}` : 'Price unavailable'}</strong>
            <time dateTime={Number.isNaN(viewedDate.getTime()) ? undefined : viewedDate.toISOString()}>Last viewed {formatDate(record.viewedAt)}</time>
            <div className="history-product-actions">
              {!unavailable && <Link className="home-view-btn" to={`/products/${encodeURIComponent(record.productId)}`}>View Product <span aria-hidden="true">↗</span></Link>}
              <button type="button" className="history-remove-btn" onClick={() => onRemove(record.productId)}>Remove from History</button>
            </div>
          </div>
        </article>;
      })}</div> : <div className="history-empty-state"><span aria-hidden="true">⌕</span><h2>Your next discovery starts here.</h2><p>Products you explore will appear in this history so you can find them again.</p><button type="button" className="home-primary-btn" onClick={() => navigate('/products')}>Explore Products <span aria-hidden="true">↗</span></button></div>}
  </div></main>;
}

function PlansPage({ auth, onSignIn, onSubscriptionChange }) {
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [current, setCurrent] = useState(null);
  const [trialStatus, setTrialStatus] = useState(null);
  const [trialPrompt, setTrialPrompt] = useState('');
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [activation, setActivation] = useState(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      requestApi('/api/plans'),
      auth ? requestApi('/api/subscription') : Promise.resolve(null),
      auth ? requestApi('/api/ai/trial/status') : Promise.resolve(null),
    ]).then(([planResult, subscriptionResult, trialResult]) => {
      if (!active) return;
      setPlans(planResult.plans || []);
      setCurrent(subscriptionResult?.current || null);
      setTrialStatus(trialResult);
    }).catch((error) => {
      if (active) setMessage(error.message || 'Plans are temporarily unavailable.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [auth]);

  const choosePlan = (plan) => {
    setMessage('');
    if (!auth) { onSignIn(); return; }
    if (current?.plan && current.plan !== 'Starter' && current.expiryDate && new Date(current.expiryDate) > new Date()) {
      setMessage(`Your ${current.plan} plan remains active until it expires. Plan changes are available afterward.`);
      return;
    }
    if (plan.name === 'Starter') return;
    setSelectedPlan(plan);
    setPaymentMethod('');
    setPin('');
  };

  const chooseTrial = (plan) => {
    if (!auth) { onSignIn(); return; }
    setTrialPrompt(plan);
  };

  const completeActivation = async (result, plan) => {
    setActivation({ plan: plan.name, amount: plan.price, cashback: result.cashback || 0, credits: result.credits || 0 });
    setCurrent(result.subscription);
    requestApi('/api/ai/trial/status').then(setTrialStatus).catch((error) => setMessage(`Plan activated, but trial status could not be refreshed: ${error.message}`));
    setSelectedPlan(null);
    setPin('');
    onSubscriptionChange();
  };

  const payWallet = async (event) => {
    event.preventDefault();
    if (busy || pin.length !== 4) return;
    setBusy(true);
    setMessage('');
    try {
      const key = globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await requestApi('/api/subscription/wallet', {
        method: 'POST',
        body: JSON.stringify({ plan: selectedPlan.name, pin, idempotencyKey: key }),
      });
      await completeActivation(result, selectedPlan);
    } catch (error) {
      setMessage(error.message);
      setPin('');
    } finally { setBusy(false); }
  };

  const payRazorpay = async () => {
    if (!window.Razorpay || busy) { setMessage('Razorpay checkout is unavailable. Please try again.'); return; }
    setBusy(true);
    setMessage('');
    try {
      const order = await requestApi('/api/subscription/razorpay/order', {
        method: 'POST',
        body: JSON.stringify({ plan: selectedPlan.name }),
      });
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'Innovation Labs',
        description: `${selectedPlan.name} monthly plan`,
        prefill: { name: auth.name, email: auth.email },
        theme: { color: '#00d1ff' },
        handler: async (response) => {
          try {
            const result = await requestApi('/api/subscription/razorpay/verify', { method: 'POST', body: JSON.stringify(response) });
            await completeActivation(result, selectedPlan);
          } catch (error) { setMessage(error.message); }
          finally { setBusy(false); }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      checkout.open();
    } catch (error) {
      setMessage(error.message);
      setBusy(false);
    }
  };

  const planIcons = { Starter: '♧', Medium: '◈', Premium: '✦', Exclusive: '♛' };
  const paidSubscriptionActive = Boolean(trialStatus?.subscription && trialStatus.subscription.expiryDate && new Date(trialStatus.subscription.expiryDate) > new Date());
  const trialUsed = Boolean(trialStatus?.trial?.used);
  const trialActive = Boolean(trialStatus?.trial?.active);

  return <main className="page-shell plans-page">
    <div className="container">
      <header className="plans-heading">
        <span className="eyebrow">Memberships for makers</span>
        <h1>Plans <span>&amp; AI</span></h1>
        <p>Keep building at your pace. Add practical AI help when you need it.</p>
      </header>
      {message && <div className="alert-box" role="alert">{message}</div>}
      {loading ? <p className="plans-loading">Loading plans...</p> : <>
        <div className="plan-grid">
          {plans.map((plan, index) => {
            const active = current?.plan === plan.name;
            return <article className={`plan-card plan-${plan.name.toLowerCase()} ${active ? 'is-current' : ''}`} key={plan.name} style={{ '--plan-order': index }}>
              <div className="plan-card-top"><span className="plan-icon" aria-hidden="true">{planIcons[plan.name]}</span>{active && <span className="plan-current-label">Current plan</span>}</div>
              <h2>{plan.name}</h2>
              <p className="plan-price"><strong>{plan.price === 0 ? 'Free' : `₹${plan.price.toLocaleString('en-IN')}`}</strong><span>{plan.price ? '/ month' : 'forever'}</span></p>
              <p className="plan-summary">{plan.name === 'Starter' ? 'Everything you need to browse and build.' : plan.name === 'Medium' ? 'More support for projects in progress.' : plan.name === 'Premium' ? 'A capable AI partner for finding and preparing parts.' : 'Advanced AI help, including confirmed purchase assistance.'}</p>
              {plan.credits > 0 && <div className="plan-credit-line">{plan.credits.toLocaleString('en-IN')} AI credits each month</div>}
              {plan.cashback > 0 && <div className="plan-cashback-line">₹{plan.cashback} one-time wallet cashback</div>}
              <button className={active ? 'secondary-btn full' : 'primary-btn full'} disabled={active || (current?.plan && current.plan !== 'Starter' && current.expiryDate && new Date(current.expiryDate) > new Date())} onClick={() => choosePlan(plan)}>
                {active ? 'Your current plan' : current?.plan && current.plan !== 'Starter' && current.expiryDate && new Date(current.expiryDate) > new Date() ? 'Available after expiry' : plan.price === 0 ? 'Included by default' : auth ? 'Choose plan' : 'Sign in to subscribe'}
              </button>
              {['Premium', 'Exclusive'].includes(plan.name) && !paidSubscriptionActive && <button className="secondary-btn full ai-trial-plan-button" disabled={auth && !trialStatus || trialUsed || trialActive} onClick={() => chooseTrial(plan.name)}>
                {!auth ? 'Sign in for Free Trial' : !trialStatus ? 'Checking trial eligibility...' : trialActive ? `${trialStatus.trial.plan} Trial Active` : trialUsed ? 'Free Trial Already Used' : 'Start 4-Day Free Trial'}
              </button>}
            </article>;
          })}
        </div>
        {trialActive && <section className="ai-trial-status-card"><div><span className="eyebrow">Free trial active</span><h2>{trialStatus.trial.plan} AI trial</h2><p>Activated {new Date(trialStatus.trial.activatedAt).toLocaleString('en-IN')} · Expires {new Date(trialStatus.trial.expiresAt).toLocaleString('en-IN')}</p></div><div className="ai-trial-status-facts"><span><strong>{trialStatus.trial.remainingBuilds ?? 0}</strong> of 2 project builds remaining</span><span>Trial cashback is not awarded. Trial access expires automatically.</span></div></section>}
        <section className="plan-comparison" aria-labelledby="comparison-heading">
          <div className="comparison-heading"><span className="eyebrow">At a glance</span><h2 id="comparison-heading">Compare plans</h2></div>
          <div className="comparison-scroll" tabIndex="0" aria-label="Scrollable plan comparison">
            <table className="comparison-table">
              <thead><tr><th scope="col">Feature</th>{plans.map((plan) => <th scope="col" key={plan.name}>{plan.name}</th>)}</tr></thead>
              <tbody>{(plans[0]?.features || []).map((feature, featureIndex) => <tr key={feature.label}>
                <th scope="row">{feature.label}</th>
                {plans.map((plan) => {
                  const planFeature = plan.features[featureIndex];
                  const included = planFeature?.included;
                  const value = planFeature?.value;
                  return <td key={plan.name} className={included ? 'feature-yes' : 'feature-no'} aria-label={value || (included ? 'Available' : 'Not available')}>{value || (included ? '✓' : '✕')}</td>;
                })}
              </tr>)}</tbody>
            </table>
          </div>
          <p className="plan-terms">Subscriptions run for one month from activation. Included credits refresh on renewal; unused credits remain available while your paid plan is active.</p>
          <p className="plan-terms ai-trial-footnote">* Premium includes four project builds during an active paid subscription. Premium and Exclusive free trials include two project builds.</p>
        </section>
      </>}
    </div>

    {selectedPlan && <div className="plan-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setSelectedPlan(null); }}>
      <section className="plan-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title">
        <button className="plan-dialog-close" aria-label="Close subscription checkout" disabled={busy} onClick={() => setSelectedPlan(null)}>×</button>
        <span className="eyebrow">Digital subscription</span>
        <h2 id="plan-dialog-title">{selectedPlan.name} · ₹{selectedPlan.price.toLocaleString('en-IN')}</h2>
        <p>No delivery address is required. The server validates the plan price and activation.</p>
        {!paymentMethod && <div className="plan-payment-options"><button className="secondary-btn" onClick={() => setPaymentMethod('Wallet')}>◉ &nbsp; Pay with Wallet</button><button className="secondary-btn" onClick={payRazorpay}>↗ &nbsp; Razorpay / Online</button></div>}
        {paymentMethod === 'Wallet' && <form className="plan-pin-form" onSubmit={payWallet}><label htmlFor="plan-wallet-pin">Enter your Wallet PIN</label><input id="plan-wallet-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} required /><div className="plan-payment-options"><button type="button" className="secondary-btn" disabled={busy} onClick={() => setPaymentMethod('')}>Back</button><button className="primary-btn" disabled={busy || pin.length !== 4}>{busy ? 'Processing...' : 'Pay ₹' + selectedPlan.price.toLocaleString('en-IN')}</button></div></form>}
        {message && <p className="plan-dialog-error" role="alert">{message}</p>}
      </section>
    </div>}
    {activation && <div className="plan-dialog-backdrop"><section className="plan-dialog plan-success" role="dialog" aria-modal="true" aria-labelledby="activation-title">
      <div className="success-check" aria-hidden="true">✓</div><span className="eyebrow">Payment confirmed</span>
      <h2 id="activation-title">{activation.plan} activated</h2>
      <p>₹{activation.amount.toLocaleString('en-IN')} payment successful.</p>
      {activation.cashback > 0 && <p>₹{activation.cashback.toLocaleString('en-IN')} wallet cashback added once.</p>}
      {activation.credits > 0 && <p>{activation.credits.toLocaleString('en-IN')} AI credits added.</p>}
      <button className="primary-btn full" onClick={() => setActivation(null)}>Continue</button>
    </section></div>}
    {trialPrompt && <div className="plan-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTrialPrompt(''); }}><section className="plan-dialog ai-trial-terms-dialog" role="dialog" aria-modal="true" aria-labelledby="trial-terms-title">
      <button className="plan-dialog-close" aria-label="Close trial information" onClick={() => setTrialPrompt('')}>×</button>
      <span className="eyebrow">Four-day free trial</span><h2 id="trial-terms-title">{trialPrompt} AI Project Builder Trial</h2>
      <p>Try {trialPrompt} project-building features for four consecutive days from activation, including two successful project builds. {trialPrompt === 'Premium' ? 'AI-assisted cart addition is included during the trial.' : 'AI-assisted cart addition and checkout preparation are included during the trial; checkout still requires your explicit confirmation and normal secure payment.'}</p>
      <ul><li>No paid subscription is created.</li><li>No recurring billing or automatic payment is started.</li><li>No wallet cashback is awarded for trial activation.</li><li>Your one-time trial eligibility is recorded to your account.</li></ul>
      <div className="plan-payment-options"><button className="secondary-btn" onClick={() => setTrialPrompt('')}>Cancel</button><button className="primary-btn" onClick={() => { const plan = trialPrompt; setTrialPrompt(''); navigate(`/plans/ai-trial/${plan}`); }}>Continue to activation</button></div>
    </section></div>}
  </main>;
}

function AccountPlanSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { requestApi('/api/subscription').then(setData).catch((requestError) => setError(requestError.message)); }, []);
  const toggleAutoRenew = async (enabled) => {
    setBusy(true);
    setError('');
    try {
      const result = await requestApi('/api/subscription/auto-renew', { method: 'PATCH', body: JSON.stringify({ enabled }) });
      setData((current) => ({ ...current, current: result.subscription }));
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  const current = data?.current;
  return <>
    <div className="account-section-heading"><h2>Current Plan</h2><Link to="/plans">Compare plans</Link></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {current ? <section className="account-panel current-plan-panel"><div><span className="eyebrow">Your membership</span><h3>{current.plan}</h3><strong>{current.plan === 'Starter' ? '₹0/month' : `₹${Number(current.price || (current.pricePaise || 0) / 100).toLocaleString('en-IN')}/month`}</strong></div>
      {current.plan !== 'Starter' && <><p>Started: {current.startDate ? new Date(current.startDate).toLocaleDateString() : 'Not available'}</p><p>Expires: {current.expiryDate ? new Date(current.expiryDate).toLocaleDateString() : 'Not available'}</p><label className="renew-toggle"><span>Auto Renew</span><input type="checkbox" checked={Boolean(current.autoRenew)} disabled={busy || current.status !== 'active'} onChange={(event) => toggleAutoRenew(event.target.checked)} /><span>{current.autoRenew ? 'ON' : 'OFF'}</span></label><p className="plan-terms">Turning auto-renew off keeps your plan active through its expiry date. Unused AI credits are available only while a paid plan is active.</p></>}
      {current.plan === 'Starter' && <p>Starter is your default plan. Upgrade anytime to add AI features.</p>}
    </section> : <p>Loading your plan...</p>}
    {data?.history?.length > 0 && <section className="account-panel plan-history"><h3>Subscription history</h3>{data.history.map((item) => <div className="plan-history-row" key={item._id}><strong>{item.plan}</strong><span>{new Date(item.startDate).toLocaleDateString()} – {new Date(item.expiryDate).toLocaleDateString()}</span><span>{item.status}</span></div>)}</section>}
  </>;
}

function AITrialActivationPage({ auth, onSignIn }) {
  const { plan: routePlan = '' } = useParams();
  const navigate = useNavigate();
  const plan = routePlan.charAt(0).toUpperCase() + routePlan.slice(1).toLowerCase();
  const [status, setStatus] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!auth) return undefined;
    let active = true;
    requestApi('/api/ai/trial/status')
      .then((result) => { if (active) setStatus(result); })
      .catch((requestError) => { if (active) setError(requestError.message); });
    return () => { active = false; };
  }, [auth]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activate = async () => {
    if (!auth) { onSignIn(); return; }
    if (!['Premium', 'Exclusive'].includes(plan) || !accepted || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await requestApi('/api/ai/trial/activate', {
        method: 'POST',
        body: JSON.stringify({ plan, termsAccepted: true }),
      });
      setStatus({ trial: result.trial, subscription: null });
      setNotice(result.message);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };
  const trial = status?.trial;
  const remainingMs = trial?.active && trial.expiresAt ? Math.max(0, new Date(trial.expiresAt).getTime() - now) : 0;
  const remainingTime = `${Math.floor(remainingMs / 86400000)}d ${Math.floor((remainingMs % 86400000) / 3600000)}h ${Math.floor((remainingMs % 3600000) / 60000)}m`;
  const unavailable = Boolean(trial?.used || status?.subscription || !trial?.eligible);

  if (!['Premium', 'Exclusive'].includes(plan)) return <main className="page-shell"><div className="container ai-trial-activation"><div className="alert-box">Choose the Premium or Exclusive trial from Plans &amp; AI.</div><Link className="secondary-btn" to="/plans">Back to Plans &amp; AI</Link></div></main>;
  if (!auth) return <SignInRequiredPage onSignIn={onSignIn} />;

  return <main className="page-shell"><div className="container ai-trial-activation">
    <Link className="back-link" to="/plans">← Plans &amp; AI</Link>
    <section className="ai-trial-activation-card">
      <span className="eyebrow">Innovation Labs · Free Trial</span>
      <h1>{trial?.active ? `${trial.plan} Trial Active` : `${plan} AI Project Builder Trial`}</h1>
      <p className="ai-trial-activation-lead">Four consecutive days of AI project-building access with two successful project builds.</p>
      <div className="ai-trial-terms-grid"><div><strong>Duration</strong><span>4 days from server-confirmed activation</span></div><div><strong>Project builds</strong><span>{trial?.active ? `${trial.remainingBuilds} of 2 remaining` : '2 successful builds'}</span></div><div><strong>Available features</strong><span>{plan === 'Premium' ? 'Project Builder and AI-assisted component cart' : 'Project Builder, AI-assisted cart and checkout preparation'}</span></div><div><strong>Billing and cashback</strong><span>No paid subscription, recurring billing, automatic payment, or wallet cashback.</span></div></div>
      {trial?.active && <div className="ai-trial-live-status"><span>Activated {new Date(trial.activatedAt).toLocaleString('en-IN')}</span><span>Expires {new Date(trial.expiresAt).toLocaleString('en-IN')}</span><strong>{remainingTime} remaining</strong></div>}
      {error && <div className="alert-box" role="alert">{error}</div>}
      {notice && <div className="account-notice" role="status">{notice}</div>}
      {!trial?.active && <label className="ai-trial-accept"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>I have read and accept the free-trial terms. I understand that this does not activate paid billing and that my account can use one trial only.</span></label>}
      <div className="ai-trial-activation-actions">{trial?.active ? <button className="primary-btn" onClick={() => navigate('/plans')}>Continue to Plans &amp; AI</button> : <button className="primary-btn" disabled={!accepted || busy || unavailable || !status} onClick={activate}>{busy ? 'Activating trial...' : unavailable ? trial?.used ? 'Trial eligibility already used' : 'Trial unavailable' : 'Activate Free Trial'}</button>}<Link className="secondary-btn" to="/plans">Back to Plans &amp; AI</Link></div>
    </section>
  </div></main>;
}

function AICreditSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { requestApi('/api/ai-credits').then(setData).catch((requestError) => setError(requestError.message)); }, []);
  return <>
    <div className="account-section-heading"><h2>AI Credits</h2><span>Usage and remaining balance</span></div>
    {error ? <div className="alert-box" role="alert">{error}</div> : data ? <>
      <section className="credits-balance-panel"><span>Remaining Credits</span><strong>{data.balance.toLocaleString('en-IN')}</strong><p>AI credits are used when you use certain AI features.</p><Link className="primary-btn small" to="/account/ai-credits/add">Add Credits</Link></section>
      <section className="account-panel credit-history"><h3>Credit history</h3>{data.transactions.length ? data.transactions.map((transaction) => <article key={transaction._id}><span className={transaction.type === 'added' ? 'credit-added' : 'credit-used'}>{transaction.type === 'added' ? '+' : '−'}{transaction.amount}</span><div><strong>{transaction.action === 'credit_purchase' ? 'Credit Purchase' : transaction.action}</strong><small>{new Date(transaction.createdAt).toLocaleString()} · Balance {transaction.balanceAfter}</small></div></article>) : <AccountEmpty text="No credit transactions yet." />}</section>
    </> : <p>Loading your AI credits...</p>}
  </>;
}

function AddCreditsPage() {
  const navigate = useNavigate();
  const [credits, setCredits] = useState('');
  const [method, setMethod] = useState('Wallet');
  const [data, setData] = useState(null);
  const [purchase, setPurchase] = useState(null);
  const [walletBalance, setWalletBalance] = useState(null);
  const [pin, setPin] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [success, setSuccess] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    requestApi('/api/ai-credits').then(setData).catch((requestError) => setError(requestError.message));
  }, []);

  const quantity = Number(credits);
  const total = Number.isSafeInteger(quantity) && quantity > 0 ? quantity * Number(data?.pricePerCredit || 2) : 0;
  const validQuantity = Number.isSafeInteger(quantity) && quantity > 0 && quantity <= (data?.maxPurchase || 10000);

  const startPurchase = async (event) => {
    event.preventDefault();
    if (!validQuantity || busy) {
      setError(`Please enter a valid whole number of credits${data?.maxPurchase ? ` up to ${data.maxPurchase.toLocaleString('en-IN')}` : ''}.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() || `credits-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await requestApi('/api/credits/purchase', { method: 'POST', body: JSON.stringify({ credits: quantity, paymentMethod: method, idempotencyKey }) });
      setPurchase(result.purchase);
      if (method === 'Wallet') {
        const status = await requestApi(`/api/credits/purchase/${result.purchase.purchaseId}`);
        setWalletBalance(status.walletBalance);
      } else {
        const order = await requestApi('/api/credits/razorpay/create', { method: 'POST', body: JSON.stringify({ purchaseId: result.purchase.purchaseId }) });
        if (!window.Razorpay) throw new Error('Razorpay checkout is unavailable. Please try again.');
        const checkout = new window.Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amountPaise,
          currency: 'INR',
          name: 'Innovation Labs',
          description: `${quantity.toLocaleString('en-IN')} AI credits`,
          theme: { color: '#00d1ff' },
          handler: async (response) => {
            try {
              const verified = await requestApi('/api/credits/razorpay/verify', { method: 'POST', body: JSON.stringify({ ...response, purchaseId: result.purchase.purchaseId }) });
              setSuccess({ purchase: verified.purchase, balance: verified.balance });
            } catch (verifyError) { setError(verifyError.message); }
            finally { setBusy(false); }
          },
          modal: { ondismiss: () => setBusy(false) },
        });
        checkout.open();
        return;
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      if (method === 'Wallet') setBusy(false);
    }
  };

  const confirmWalletPayment = async () => {
    if (!purchase || pin.length !== 4 || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi('/api/credits/wallet/confirm', { method: 'POST', body: JSON.stringify({ purchaseId: purchase.purchaseId, pin }) });
      setPinOpen(false);
      setPin('');
      setSuccess({ purchase: result.purchase, balance: result.balance });
    } catch (requestError) {
      setError(requestError.message);
      setPin('');
    } finally { setBusy(false); }
  };

  if (success) return <CreditPurchaseSuccess success={success} onDone={() => navigate('/account/ai-credits')} />;

  return <main className="page-shell add-credits-page"><div className="container narrow-container">
    <Link className="back-link" to="/account/ai-credits">← Back to AI Credits</Link>
    <div className="section-title left"><span className="eyebrow">AI Credits</span><h1>Add Credits</h1><p>Purchase additional AI credits</p></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    <form className="add-credits-card" onSubmit={startPurchase}>
      <div className="credit-price-note"><span>Price per credit</span><strong>₹{Number(data?.pricePerCredit || 2).toLocaleString('en-IN')}</strong></div>
      <label>How many credits do you want to add?<input inputMode="numeric" pattern="[0-9]*" value={credits} disabled={Boolean(purchase)} onChange={(event) => setCredits(event.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="Enter credits" aria-describedby="credit-total" /></label>
      <div className="credit-total" id="credit-total"><span>Total Amount</span><strong>₹{total.toLocaleString('en-IN')}</strong></div>
      <div className="credit-method-picker"><strong>Choose Payment Method</strong><label><input type="radio" checked={method === 'Wallet'} disabled={Boolean(purchase)} onChange={() => setMethod('Wallet')} /> Wallet</label><label><input type="radio" checked={method === 'Razorpay'} disabled={Boolean(purchase)} onChange={() => setMethod('Razorpay')} /> Online Payment</label></div>
      {purchase && method === 'Wallet' && <div className="wallet-credit-summary">
        <div><span>Credits</span><strong>{purchase.credits.toLocaleString('en-IN')}</strong></div>
        <div><span>Current Wallet Balance</span><strong>{walletBalance == null ? 'Verify with PIN' : `₹${walletBalance.toLocaleString('en-IN')}`}</strong></div>
        <div><span>Balance After Payment</span><strong>{walletBalance == null ? 'Shown after verification' : `₹${Math.max(0, walletBalance - purchase.totalAmount).toLocaleString('en-IN')}`}</strong></div>
        {walletBalance != null && walletBalance < purchase.totalAmount && <><p className="wallet-insufficient">Insufficient wallet balance. Required: ₹{purchase.totalAmount.toLocaleString('en-IN')} · Available: ₹{walletBalance.toLocaleString('en-IN')}</p><Link className="secondary-btn small" to="/wallet">Add Money to Wallet</Link></>}
      </div>}
      {purchase?.paymentMethod === 'Wallet' && (walletBalance == null || walletBalance >= purchase.totalAmount) && <button type="button" className="primary-btn full" disabled={busy} onClick={() => setPinOpen(true)}>{busy ? 'Processing Payment...' : `Pay ₹${purchase.totalAmount.toLocaleString('en-IN')}`}</button>}
      {!purchase && <button className="primary-btn full" disabled={busy || !validQuantity}>{busy ? 'Preparing Payment...' : 'Continue'}</button>}
    </form>
    {pinOpen && <div className="wallet-lock-overlay"><div className="wallet-pin-modal"><h2>Confirm Wallet Payment</h2><p>Amount ₹{purchase.totalAmount.toLocaleString('en-IN')} · {purchase.credits.toLocaleString('en-IN')} Credits</p><p>Enter your 4-digit wallet PIN.</p><PinBoxes value={pin} onChange={(value) => { setPin(value); setError(''); }} /><>{error && <p className="voice-error" role="alert">{error}</p>}</><div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setPinOpen(false)}>Cancel</button><button className="primary-btn" disabled={busy || pin.length !== 4} onClick={confirmWalletPayment}>{busy ? 'Confirming...' : 'Confirm Payment'}</button></div></div></div>}
  </div></main>;
}

function CreditPurchaseSuccess({ success, onDone }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => { const timer = setTimeout(() => setLoading(false), 1200); return () => clearTimeout(timer); }, []);
  if (loading) return <main className="page-shell confirmation-shell"><div className="container loader-wrap"><div className="spinner" /><p>Processing your credit payment...</p></div></main>;
  return <main className="page-shell confirmation-shell"><div className="container credit-success"><div className="success-badge">✓</div><h1>Payment Successful</h1><p className="confirmation-intro">Credits Added</p><div className="credit-success-grid"><div><span>Credits Added</span><strong>+{success.purchase.credits.toLocaleString('en-IN')}</strong></div><div><span>Amount Paid</span><strong>₹{success.purchase.totalAmount.toLocaleString('en-IN')}</strong></div><div><span>New Credit Balance</span><strong>{Number(success.balance).toLocaleString('en-IN')} Credits</strong></div></div><p>Transaction {success.purchase.purchaseId}</p><button className="primary-btn" onClick={onDone}>Done</button></div></main>;
}

function AIAssistant({ plan, cart, service, onAddComponentsToCart, onPrepareCheckout, onOpenCustomBuilding, onNavigate, openSignal }) {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [entitlements, setEntitlements] = useState(null);
  const [project, setProject] = useState(null);
  const [checkoutEstimate, setCheckoutEstimate] = useState(null);
  const [retryIdea, setRetryIdea] = useState('');
  const [messages, setMessages] = useState([{ role: 'assistant', text: 'Describe the electronics project you want to build. I can recommend real catalog components, estimate their current cost, and prepare a custom-building brief.' }]);
  const feedRef = useRef(null);
  const appliedActionKeys = useRef(new Set());

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    let active = true;
    requestApi('/api/ai/entitlements')
      .then((result) => { if (active) setEntitlements(result); })
      .catch((error) => { if (active) setMessages((current) => [...current, { role: 'assistant', text: `AI entitlements are unavailable: ${error.message}` }]); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (open && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [messages, project, open, maximized, busy]);

  const showMessage = (text) => setMessages((current) => [...current, { role: 'assistant', text }]);
  const createProject = async (idea) => {
    const budgetMatch = idea.match(/\b(?:under|within|budget(?: of)?)\s*(?:₹|rs\.?\s*)?([\d,]+)/i);
    const budget = budgetMatch ? Number(budgetMatch[1].replaceAll(',', '')) : undefined;
    const result = await requestApi('/api/ai/project-builder', {
      method: 'POST',
      body: JSON.stringify({
        idea,
        ...(budget ? { budget } : {}),
        idempotencyKey: globalThis.crypto?.randomUUID?.() || `build-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      }),
    });
    setProject(result);
    setRetryIdea('');
    if (result.entitlements) setEntitlements((current) => current ? { ...current, entitlements: result.entitlements } : current);
    showMessage(`Project prepared: ${result.title}. Estimated catalog component subtotal: ₹${Number(result.estimatedComponentSubtotal).toLocaleString('en-IN')}.`);
  };

  const addComponents = async (items) => {
    if (!entitlements?.entitlements?.addComponents) {
      showMessage('AI-assisted cart addition is locked on this plan. Upgrade to Premium or Exclusive to add recommended components through AI.');
      return;
    }
    if (!items.length) {
      showMessage('There are no available matched catalog components to add.');
      return;
    }
    const idempotencyKey = globalThis.crypto?.randomUUID?.() || `ai-cart-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (appliedActionKeys.current.has(idempotencyKey)) return;
    setBusy(true);
    showMessage('Checking component availability and current prices…');
    try {
      const result = await onAddComponentsToCart(items, idempotencyKey);
      if (!result.alreadyApplied) appliedActionKeys.current.add(idempotencyKey);
      const addedText = result.added?.length ? `Added ${result.added.map((item) => `${item.name} × ${item.quantity}`).join(', ')} to your cart.` : '';
      const unavailableText = result.unavailable?.length ? ` Not added: ${result.unavailable.map((item) => `${item.name || item.productId} — ${item.reason}`).join('; ')}` : '';
      showMessage(result.alreadyApplied ? 'This cart action was already applied.' : `${addedText || result.message}${unavailableText}`);
    } catch (error) {
      showMessage(`Unable to add the components: ${error.message}`);
    } finally { setBusy(false); }
  };

  const checkout = async () => {
    if (!project?.customBuildingPrompt) {
      showMessage('Build a project first so I can prepare the matching requirements for checkout.');
      return;
    }
    if (!entitlements?.entitlements?.checkoutAssistance) {
      showMessage('AI-assisted checkout preparation is an Exclusive feature. You can still continue through the regular checkout.');
      return;
    }
    setBusy(true);
    showMessage('Checking your current cart and preparing the existing checkout…');
    try {
      const result = await requestApi('/api/ai/checkout-assistance', {
        method: 'POST',
        body: JSON.stringify({ items: cart, service, projectDescription: project.customBuildingPrompt }),
      });
      setCheckoutEstimate(result.estimate);
      showMessage(`Your cart was checked against the live catalog. Current estimate before discounts: ₹${Number(result.estimate.totalBeforeDiscounts).toLocaleString('en-IN')}. Choose a payment method below to open the existing checkout, then review the project option and final total. No order has been placed.`);
    } catch (error) {
      showMessage(`Checkout could not be prepared: ${error.message}`);
    } finally { setBusy(false); }
  };

  const chooseCheckoutPayment = async (paymentMethod) => {
    if (!checkoutEstimate || busy || !project?.customBuildingPrompt) return;
    setBusy(true);
    showMessage(`Opening the existing checkout with ${paymentMethod} selected. You will review the order and explicitly confirm payment there.`);
    try {
      await onPrepareCheckout(project.customBuildingPrompt, paymentMethod);
    } catch (error) {
      showMessage(`Checkout could not be opened: ${error.message}`);
    } finally { setBusy(false); }
  };

  const send = async (event) => {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((current) => [...current, { role: 'user', text }]);
    const normalized = text.toLowerCase();
    const addAll = /\b(add|put)\b.*\b(all|required|components|parts)\b.*\b(cart|basket)\b|\b(add all|required components)\b/i.test(text);
    const checkoutIntent = /\b(checkout|check out|place (an )?order)\b/i.test(text);
    if (checkoutIntent) {
      await checkout();
      return;
    }
    if (addAll) {
      if (!entitlements?.entitlements?.addComponents) {
        showMessage('AI-assisted cart addition is locked on Starter and Medium. Premium and Exclusive paid plans, and their eligible trials, can use this feature.');
        return;
      }
      if (!project) {
        showMessage('Build a project first so I can add its actual catalog recommendations.');
        return;
      }
      await addComponents(project.components.filter((item) => item.available && item.product).map((item) => ({ productId: item.product.id, quantity: item.quantity })));
      return;
    }
    if (/\b(search|identify|navigate|open my account|show me a product)\b/i.test(normalized) && !/\b(build|make|create|design|project|robot|sensor|arduino)\b/i.test(normalized)) {
      showMessage('This assistant is limited to the AI Project Builder in this phase. Describe an electronics project to get a component plan.');
      return;
    }
    setBusy(true);
    showMessage('Designing your project using the current Innovation Labs catalog…');
    try {
      await createProject(text);
    } catch (error) {
      setRetryIdea(text);
      showMessage(error.message);
      if (error.status === 403 || error.status === 402) onNavigate('/plans');
    } finally { setBusy(false); }
  };

  const retryProject = async () => {
    if (!retryIdea || busy) return;
    const idea = retryIdea;
    setBusy(true);
    setMessages((current) => [...current, { role: 'user', text: idea }]);
    showMessage('Retrying the project request…');
    try { await createProject(idea); }
    catch (error) {
      setRetryIdea(idea);
      showMessage(error.message);
      if (error.status === 403 || error.status === 402) onNavigate('/plans');
    } finally { setBusy(false); }
  };

  const copyPrompt = async () => {
    if (!project?.customBuildingPrompt) return;
    try {
      await navigator.clipboard.writeText(project.customBuildingPrompt);
      showMessage('Custom Building prompt copied. Paste this prompt into Custom Building, select your preferred building option, and continue with the existing order form.');
    } catch {
      showMessage('Clipboard access was blocked. Select and copy the Custom Building prompt from the project card.');
    }
  };
  const openCustomBuilding = () => {
    if (!project?.customBuildingPrompt) {
      onNavigate('/custom-order');
      return;
    }
    onOpenCustomBuilding(project.customBuildingPrompt);
  };

  return <>
    {!open && <button className="ai-launcher" aria-label="Open Innovation AI Project Builder" onClick={() => setOpen(true)}><span aria-hidden="true">✦</span><span>AI</span></button>}
    {open && <section className={`ai-chat-panel ai-project-builder-panel ${maximized ? 'is-maximized' : ''}`} aria-label="AI Project Builder">
      <header className="ai-chat-header"><div className="ai-chat-identity"><span className="ai-chat-mark" aria-hidden="true">✦</span><div><strong>Innovation AI</strong><small>{entitlements?.plan || plan}{entitlements?.accessType === 'trial' ? ' · Free Trial' : ' · Project Builder'}</small></div></div><div className="ai-chat-controls"><button title={maximized ? 'Minimize panel' : 'Maximize panel'} aria-label={maximized ? 'Minimize panel' : 'Maximize panel'} onClick={() => setMaximized((value) => !value)}>{maximized ? '↙' : '↗'}</button><button title="Close AI panel" aria-label="Close AI panel" onClick={() => { setOpen(false); setMaximized(false); }}>×</button></div></header>
      <div className="ai-chat-feed" ref={feedRef} aria-live="polite">
        {entitlements && <div className="ai-builder-entitlement"><span>{entitlements.accessType === 'trial' ? `${entitlements.trial.plan} trial` : entitlements.plan}</span><span>{entitlements.entitlements.buildLimit == null ? 'Unlimited builds' : `${entitlements.entitlements.remainingBuilds} of ${entitlements.entitlements.buildLimit} builds remaining`}</span></div>}
        {messages.map((item, index) => <div className={`ai-message ${item.role}`} key={`${index}-${item.text}`}>{item.text}{item.text.includes('Upgrade') && <button className="ai-exclusive-link" onClick={() => onNavigate('/plans')}>View Plans &amp; AI</button>}</div>)}
        {retryIdea && !busy && <button type="button" className="ai-project-retry" onClick={retryProject}>Retry project request</button>}
        {checkoutEstimate && <section className="ai-checkout-payment-choice" aria-label="Choose checkout payment method"><strong>Choose how to continue</strong><p>Final totals and payment authorization will be handled in secure checkout. Wallet PINs are entered only in the existing trusted PIN dialog.</p><button type="button" disabled={busy} onClick={() => chooseCheckoutPayment('Wallet')}>Continue with Wallet</button><button type="button" disabled={busy} onClick={() => chooseCheckoutPayment('Online Payment')}>Continue with Online Payment</button></section>}
        {project && <section className="ai-project-result" aria-label="Generated project plan">
          <header><span className="eyebrow">Project plan</span><h2>{project.title}</h2><p>{project.description}</p></header>
          <div className="ai-project-summary"><div><span>Objective</span><p>{project.objective}</p></div><div><span>Expected behaviour</span><p>{project.expectedBehavior}</p></div></div>
          <div className="ai-project-cost"><span>Estimated component subtotal</span><strong>₹{Number(project.estimatedComponentSubtotal).toLocaleString('en-IN')}</strong><small>{project.estimateNote}</small></div>
          <div className="ai-project-components"><div className="ai-project-section-heading"><h3>Required components</h3><span>{project.components.length} items</span></div>
            {project.components.map((component, index) => <article className="ai-project-component" key={`${component.name}-${index}`}>
              {component.product?.images?.[0] ? <img src={component.product.images[0]} alt={component.product.name} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} /> : <img src={fallbackProductImage} alt="" />}
              <div className="ai-project-component-content"><strong>{component.product?.name || component.name}</strong><span>{component.specifications || component.product?.category || 'Specification not provided'}</span><small>{component.quantity} required · {component.availability}</small>
                {component.product && <><span>₹{Number(component.product.price).toLocaleString('en-IN')} each · line ₹{Number(component.product.lineTotal).toLocaleString('en-IN')}</span><a href={component.product.productUrl}>View product details</a></>}
                {component.wiringHint && <small>Wiring: {component.wiringHint}</small>}
                {component.product && <div className="ai-project-component-actions"><button type="button" disabled={!component.available || !entitlements?.entitlements?.addComponents || busy} onClick={() => addComponents([{ productId: component.product.id, quantity: component.quantity }])}>{!entitlements?.entitlements?.addComponents ? 'Cart addition locked' : component.available ? 'Add to Cart' : 'Unavailable'}</button></div>}
              </div>
            </article>)}
          </div>
          <div className="ai-project-wiring"><h3>Wiring plan</h3><ol>{project.wiringPlan.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></div>
          <label className="ai-custom-prompt"><span>Custom Building prompt</span><textarea readOnly rows={7} value={project.customBuildingPrompt} /></label>
          <div className="ai-project-actions"><button type="button" className="secondary-btn" onClick={copyPrompt}>Copy Custom Building Prompt</button><button type="button" className="secondary-btn" onClick={openCustomBuilding}>Open Custom Building</button>
            {entitlements?.entitlements?.addComponents && <button type="button" className="primary-btn" disabled={busy || !project.components.some((item) => item.available && item.product)} onClick={() => addComponents(project.components.filter((item) => item.available && item.product).map((item) => ({ productId: item.product.id, quantity: item.quantity })))}>Add all available components</button>}
            {entitlements?.entitlements?.checkoutAssistance && <button type="button" className="primary-btn" disabled={busy || !cart.some((item) => !item.promoReservationId && !item.discountOfferId)} onClick={checkout}>Prepare Exclusive Checkout</button>}
          </div>
        </section>}
        {busy && <div className="ai-message assistant ai-progress" role="status"><span className="spinner" /> Working with the secure catalog and current entitlements…</div>}
      </div>
      <form className="ai-chat-input" onSubmit={send}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Describe a project or ask to add its components" aria-label="Describe an electronics project" maxLength={2000} /><button disabled={busy || !input.trim()} aria-label="Send project request">↑</button></form>
      <footer className="ai-chat-safety">Project Builder only. Never enter a PIN, password, OTP, or card details here.</footer>
    </section>}
  </>;
}

function ProductsPage({ cart, wishlist, auth, onSignIn, onTrackViewed, onAddToCart, onAddWishlistItem, onQty, onAddPromoToCart, initialCategory = 'All Products' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(initialCategory);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [promoCodes, setPromoCodes] = useState([]);
  const [discountOffers, setDiscountOffers] = useState([]);
  const [promoLoading, setPromoLoading] = useState(false);
  const [discountOffersLoading, setDiscountOffersLoading] = useState(false);
  const [discountOffersError, setDiscountOffersError] = useState('');
  const [promoError, setPromoError] = useState('');
  const [reservingId, setReservingId] = useState('');
  const [purchaseSelectionPromo, setPurchaseSelectionPromo] = useState(null);
  const [selectedPurchaseType, setSelectedPurchaseType] = useState('online');
  const [selectedRecipientType, setSelectedRecipientType] = useState('myself');
  const categories = ['All Products', ...new Set(catalog.map((product) => product.category).filter(Boolean))];
  const availableCategoriesKey = categories.join('\u0000');
  const requestedCategory = searchParams.get('category');
  const physicalCartPresent = cart.some((item) => !item.promoReservationId);

  useEffect(() => {
    if (location.pathname === '/discount-codes') {
      setCategory('Discount Promo Codes');
      return;
    }
    const matchingCategory = categories.find((item) => item.toLocaleLowerCase() === requestedCategory?.toLocaleLowerCase());
    setCategory(matchingCategory || initialCategory);
  }, [location.pathname, location.search, initialCategory, availableCategoriesKey]);

  useEffect(() => {
    let active = true;
    const loadCatalog = async () => {
      try {
        const result = await requestApi('/api/products');
        if (!active || !Array.isArray(result.products)) return;
        setCatalog(result.products.map((item) => ({
          ...item,
          price: Number(item.price),
          image: historyProductImage(item),
          inventoryProduct: Boolean(item.inventoryProduct),
        })));
        setCatalogError('');
      } catch (error) {
        if (active) setCatalogError(`The product catalogue could not be loaded: ${error.message}`);
      } finally {
        if (active) setCatalogLoading(false);
      }
    };
    const onFocus = () => loadCatalog();
    loadCatalog();
    const interval = window.setInterval(loadCatalog, 15000);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (category !== 'Promo Codes' || !auth) return undefined;
    let active = true;
    setPromoLoading(true);
    setPromoError('');
    requestApi('/api/promo-codes/available').then((result) => {
      if (active) setPromoCodes(result.promoCodes || []);
    }).catch((error) => {
      if (active) setPromoError(error.message);
    }).finally(() => {
      if (active) setPromoLoading(false);
    });
    return () => { active = false; };
  }, [category, auth]);

  useEffect(() => {
    if (category !== 'Discount Promo Codes' || !auth) return undefined;
    let active = true;
    setDiscountOffersLoading(true);
    setDiscountOffersError('');
    requestApi('/api/discount-offers').then((result) => {
      if (active) setDiscountOffers(result.offers || []);
    }).catch((error) => {
      if (active) setDiscountOffersError(error.message);
    }).finally(() => {
      if (active) setDiscountOffersLoading(false);
    });
    return () => { active = false; };
  }, [category, auth]);

  const filtered = catalog.filter((product) => {
    const text = query.trim().toLowerCase();
    const matchesQuery = !text || `${product.name} ${product.category} ${product.description}`.toLowerCase().includes(text);
    const matchesCategory = category === 'All Products' || product.category === category;
    return matchesQuery && matchesCategory;
  });

  const chooseCategory = (nextCategory) => {
    setCategory(nextCategory);
    setMobileDrawerOpen(false);
  };

  const addPromoToCart = async (promo, purchaseType, recipientType) => {
    if (!auth) {
      onSignIn();
      return;
    }
    if (physicalCartPresent) {
      setPromoError('Complete or clear physical products from your cart before adding a Promo Code.');
      return;
    }
    if (reservingId) return;
    setReservingId(promo.id);
    setPromoError('');
    const reservationKey = globalThis.crypto?.randomUUID?.() || `promo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const reservation = await requestApi('/api/promo-codes/reserve', {
        method: 'POST',
        body: JSON.stringify({ promoCodeId: promo.id, reservationKey, purchaseType, recipientType }),
      });
      onAddPromoToCart(promo, reservation);
      setPurchaseSelectionPromo(null);
    } catch (error) {
      setPromoError(error.message);
      requestApi('/api/promo-codes/available')
        .then((result) => setPromoCodes(result.promoCodes || []))
        .catch((refreshError) => setPromoError(`Promo Codes could not be refreshed: ${refreshError.message}`));
    } finally {
      setReservingId('');
    }
  };

  const sidebar = <aside className={`products-sidebar ${collapsed ? 'is-collapsed' : ''} ${mobileDrawerOpen ? 'is-open' : ''}`} aria-label="Product categories">
    <div className="products-sidebar-heading"><strong>{collapsed ? 'P' : 'Products'}</strong><button className="products-sidebar-collapse" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand categories' : 'Collapse categories'} title={collapsed ? 'Expand categories' : 'Collapse categories'}>{collapsed ? '›' : '‹'}</button></div>
    <nav>{categories.map((item) => <button key={item} title={item} aria-current={category === item ? 'page' : undefined} className={category === item ? 'active' : ''} onClick={() => chooseCategory(item)}><span className="products-category-mark" aria-hidden="true">{item === 'All Products' ? '◈' : '•'}</span><span className="products-category-label">{item}</span></button>)}<button title="Promo Codes" aria-current={category === 'Promo Codes' ? 'page' : undefined} className={category === 'Promo Codes' ? 'active promo-category' : 'promo-category'} onClick={() => chooseCategory('Promo Codes')}><span className="products-category-mark" aria-hidden="true">◇</span><span className="products-category-label">Promo Codes</span>    </button><Link className={`discount-category-link ${category === 'Discount Promo Codes' ? 'active' : ''}`} to="/discount-codes" onClick={() => chooseCategory('Discount Promo Codes')}><span className="products-category-mark" aria-hidden="true">%</span><span className="products-category-label">Discount Promo Codes</span></Link></nav>
  </aside>;

  return <main className="page-shell products-page-shell"><div className={`container products-workspace ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <button className="products-mobile-menu" onClick={() => setMobileDrawerOpen(true)} aria-expanded={mobileDrawerOpen}>Categories <span aria-hidden="true">☰</span></button>
    {mobileDrawerOpen && <button className="products-drawer-backdrop" onClick={() => setMobileDrawerOpen(false)} aria-label="Close categories" />}
    {sidebar}
    <section className="products-main-content">
      <header className="products-main-header"><div><span className="eyebrow">Innovation Labs Catalogue</span><h1>{category}</h1></div><label className="products-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={category === 'Promo Codes' ? 'Search Promo Codes...' : 'Search products...'} aria-label="Search current category" /></label></header>
      {category === 'Discount Promo Codes' ? !auth ? <div className="empty-state"><h3>Sign in to browse Discount Promo Codes.</h3><button className="primary-btn" onClick={onSignIn}>Sign In</button></div> : discountOffersLoading ? <div className="empty-state"><div className="spinner" /><p>Loading Discount Promo Codes...</p></div> : discountOffersError && !discountOffers.length ? <div className="alert-box" role="alert">{discountOffersError}</div> : discountOffers.length ? <div className="product-grid">{discountOffers.filter((offer) => !query || `${offer.name} ${offer.discountLabel}`.toLowerCase().includes(query.toLowerCase())).map((offer) => {
        const cartId = `discount-${offer.id}`;
        const cartItem = cart.find((item) => item.discountOfferId === offer.id);
        const quantity = cartItem?.quantity || 0;
        const atStockLimit = quantity >= maxCartQuantity({ discountOfferId: offer.id, availableQuantity: offer.availableQuantity });
        const inWishlist = wishlist.some((item) => item.productType === 'discount-code' && item.productId === offer.id);
        const product = {
          id: cartId,
          discountOfferId: offer.id,
          name: offer.name,
          category: 'Discount Promo Code',
          price: Number(offer.sellingPrice),
          image: productImages.display,
          availableQuantity: Number(offer.availableQuantity),
          status: Number(offer.availableQuantity) > 0 ? 'In Stock' : 'Out of Stock',
          discountLabel: offer.discountLabel,
        };
        return <article className="product-card" key={offer.id}>
          <img src={product.image} alt="Discount Promo Code" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} />
          <div className="card-content"><span className="tag">Discount Promo Code</span><h2>{offer.name}</h2><p>{offer.discountLabel} on eligible products. Minimum purchase ₹{Number(offer.minimumPurchase).toLocaleString('en-IN')}. Expires {new Date(offer.expiresAt).toLocaleDateString('en-IN')}.</p><small className="product-stock-status">{product.status} · {offer.availableQuantity} available</small><div className="card-footer"><strong>₹{Number(offer.sellingPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong><div className="product-catalog-actions">{quantity ? <div className="product-quantity-control" aria-label={`${offer.name} quantity`}><button aria-label={`Decrease ${offer.name} quantity`} onClick={() => onQty(cartId, -1)}>−</button><span>{quantity}</span><button aria-label={`Increase ${offer.name} quantity`} disabled={atStockLimit} onClick={() => onQty(cartId, 1)}>+</button></div> : <button className="primary-btn small" disabled={offer.availableQuantity < 1} onClick={() => onAddToCart(product)}>{offer.availableQuantity < 1 ? 'Out of Stock' : 'Add to Cart'}</button>}<button className="secondary-btn small" disabled={inWishlist} onClick={() => onAddWishlistItem(product, 'discount-code', true)}>{inWishlist ? 'Added to Wishlist' : 'Add to Wishlist'}</button></div></div></div>
        </article>;
      })}</div> : <div className="empty-state"><h3>No Discount Promo Codes are available right now.</h3></div> : category === 'Promo Codes' ? !auth ? <div className="empty-state"><h3>Sign in to browse Promo Codes.</h3><button className="primary-btn" onClick={onSignIn}>Sign In</button></div> : promoLoading ? <div className="empty-state"><div className="spinner" /><p>Loading available Promo Codes...</p></div> : promoError && !promoCodes.length && !cart.some((item) => item.promoReservationId) ? <div className="alert-box" role="alert">{promoError}</div> : (() => {
        const reservedPromo = cart.find((item) => item.promoReservationId);
        const displayedPromos = [...promoCodes];
        if (reservedPromo && !displayedPromos.some((item) => item.id === reservedPromo.promoCodeId)) {
          displayedPromos.unshift({ id: reservedPromo.promoCodeId, name: reservedPromo.name, amount: reservedPromo.price });
        }
        const matchingPromos = displayedPromos.filter((promo) => !query || (promo.name || 'Digital Wallet Credit').toLowerCase().includes(query.toLowerCase()));
        return matchingPromos.length ? <div className="promo-market-grid">{matchingPromos.map((promo) => {
          const cartItem = cart.find((item) => item.promoCodeId === promo.id);
          const inWishlist = wishlist.some((item) => item.productType === 'promo' && item.productId === promo.id);
          return <article className="promo-market-card" key={promo.id}>
            <span className="tag">Digital wallet credit</span>
            {cartItem && <><span className={`promo-purchase-badge ${cartItem.purchaseType}`}>{cartItem.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</span><span className={`promo-recipient-badge ${cartItem.recipientType === 'gift' ? 'gift' : ''}`}>{cartItem.recipientType === 'gift' ? 'GIFT PURCHASE' : 'FOR MYSELF'}</span></>}
            <h2>{promo.name || 'Digital Wallet Credit'}</h2>
            <div className="promo-market-value"><span>Promo Code</span><strong>Hidden until fulfillment</strong></div>
            <div className="promo-market-value"><span>Wallet Value</span><strong>₹{Number(promo.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>
            {cartItem ? <div className="product-quantity-control" aria-label={`${cartItem.name} quantity`}><button aria-label={`Remove ${cartItem.name} from cart`} onClick={() => onQty(cartItem.id, -1)}>−</button><span>{cartItem.quantity}</span><button aria-label="Increase quantity" disabled title="Promo Codes can only be purchased once">+</button></div> : <div className="promo-market-actions">
              <button className="primary-btn small" disabled={Boolean(reservingId) || physicalCartPresent} onClick={() => { setPurchaseSelectionPromo(promo); setSelectedPurchaseType('online'); setSelectedRecipientType('myself'); }}>{reservingId === promo.id ? 'Reserving...' : physicalCartPresent ? 'Clear Cart to Continue' : 'Add to Cart'}</button>
              <button className="secondary-btn small" disabled={inWishlist} onClick={() => onAddWishlistItem(promo, 'promo')}>{inWishlist ? 'Added to Wishlist' : 'Add to Wishlist'}</button>
            </div>}
          </article>;
        })}</div> : <div className="empty-state"><h3>No Promo Codes are available right now.</h3></div>;
      })() : catalogLoading ? <div className="empty-state"><div className="spinner" /><p>Loading products...</p></div> : catalogError ? <div className="alert-box" role="alert">{catalogError}</div> : filtered.length ? <div className="product-grid">{filtered.map((product) => {
        const cartItem = cart.find((item) => item.id === product.id);
        const quantity = cartItem?.quantity || 0;
        const atStockLimit = quantity >= maxCartQuantity(product);
        const inWishlist = wishlist.some((item) => item.productType === 'product' && item.productId === product.id);
        const openDetails = () => navigate(`/products/${encodeURIComponent(product.id)}`);
        const keepCardOpen = (event) => event.stopPropagation();
        return <article className="product-card product-card-clickable" key={product.id} role="link" tabIndex={0} aria-label={`View details for ${product.name}`} onMouseEnter={() => onTrackViewed(product)} onClick={openDetails} onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          openDetails();
        }}>
        <img className="product-card-image-clickable" src={product.image} alt={product.name} onClick={openDetails} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} />
        <div className="card-content"><span className="tag">{product.category}</span><h2 className="product-card-title-clickable" onClick={openDetails}>{product.name}</h2><p>{product.description}</p>{product.inventoryProduct && <small className="product-stock-status">{product.status}{product.stock != null ? ` · ${product.stock} available` : ''}</small>}<div className="card-footer"><strong>₹{product.price.toLocaleString('en-IN')}</strong>{quantity ? <div className="product-quantity-control" aria-label={`${product.name} quantity`}><button aria-label={`Decrease ${product.name} quantity`} onClick={(event) => { keepCardOpen(event); onQty(product.id, -1); }}>−</button><span>{quantity}</span><button aria-label={`Increase ${product.name} quantity`} disabled={atStockLimit || product.status === 'Out of Stock' || cart.some((item) => item.promoReservationId)} onClick={(event) => { keepCardOpen(event); onQty(product.id, 1); }}>+</button></div> : <div className="product-catalog-actions"><button className="primary-btn small" disabled={cart.some((item) => item.promoReservationId) || product.status === 'Out of Stock' || maxCartQuantity(product) < 1} onClick={(event) => { keepCardOpen(event); onAddToCart(product); }}>{product.status === 'Out of Stock' ? 'Out of Stock' : 'Add to Cart'}</button><button className="secondary-btn small" disabled={inWishlist} onClick={(event) => { keepCardOpen(event); onAddWishlistItem(product, 'product'); }}>{inWishlist ? 'Added to Wishlist' : 'Add to Wishlist'}</button></div>}</div></div>
      </article>;
      })}</div> : <div className="empty-state"><h3>No products match this search.</h3></div>}
            {purchaseSelectionPromo && <div className="wallet-lock-overlay promo-purchase-type-overlay" onClick={() => !reservingId && setPurchaseSelectionPromo(null)}>
              <section className="promo-purchase-type-modal" role="dialog" aria-modal="true" aria-labelledby="promo-purchase-type-title" onClick={(event) => event.stopPropagation()}>
                <span className="eyebrow">Choose your delivery</span>
                <h2 id="promo-purchase-type-title">How would you like to purchase?</h2>
                <div className="promo-purchase-type-options">
                  <button type="button" className={`promo-purchase-type-option online ${selectedPurchaseType === 'online' ? 'selected' : ''}`} aria-pressed={selectedPurchaseType === 'online'} onClick={() => setSelectedPurchaseType('online')}>
                    <span className="promo-purchase-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 4h2l2.2 11.1a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 1.9-1.4L22 8H6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><circle cx="10" cy="20" r="1" fill="currentColor"/><circle cx="18" cy="20" r="1" fill="currentColor"/></svg></span>
                    <strong>Online Purchase</strong><span>Purchase your promo code digitally. No physical delivery or address required.</span>
                  </button>
                  <button type="button" className={`promo-purchase-type-option offline ${selectedPurchaseType === 'offline' ? 'selected' : ''}`} aria-pressed={selectedPurchaseType === 'offline'} onClick={() => setSelectedPurchaseType('offline')}>
                    <span className="promo-purchase-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m3 7 9-4 9 4v10l-9 4-9-4V7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m3.5 7.2 8.5 4 8.5-4M12 11.2V21M7.5 5l9 4" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg></span>
                    <strong>Offline Purchase</strong><span>Purchase with physical delivery. A delivery address and admin approval are required.</span>
                  </button>
                </div>
                <div className="promo-recipient-options" role="group" aria-label="Who is this purchase for?">
                  <strong>Who is this purchase for?</strong>
                  <div>
                    <button type="button" className={selectedRecipientType === 'myself' ? 'selected' : ''} aria-pressed={selectedRecipientType === 'myself'} onClick={() => setSelectedRecipientType('myself')}><span aria-hidden="true">◉</span><span><b>For Myself</b><small>Assign the promo code to your account.</small></span></button>
                    <button type="button" className={selectedRecipientType === 'gift' ? 'selected' : ''} aria-pressed={selectedRecipientType === 'gift'} onClick={() => setSelectedRecipientType('gift')}><span aria-hidden="true">✧</span><span><b>Order for Someone Else</b><small>Send this promo code as a gift.</small></span></button>
                  </div>
                </div>
                {promoError && <div className="alert-box" role="alert">{promoError}</div>}
                <div className="promo-purchase-type-actions"><button type="button" className="secondary-btn" disabled={Boolean(reservingId)} onClick={() => { setPurchaseSelectionPromo(null); setSelectedRecipientType('myself'); }}>Cancel</button><button type="button" className="primary-btn" disabled={Boolean(reservingId)} onClick={() => addPromoToCart(purchaseSelectionPromo, selectedPurchaseType, selectedRecipientType)}>{reservingId ? 'Reserving...' : 'Continue'}</button></div>
              </section>
            </div>}
      {category === 'Promo Codes' && promoError && promoCodes.length > 0 && <div className="voice-error" role="status">{promoError}</div>}
    </section>
  </div></main>;
}

function ProductStars({ rating, label }) {
  const filled = Math.round(Number(rating) || 0);
  return <span className="product-stars" aria-label={label || `${rating} out of 5 stars`}>{[1, 2, 3, 4, 5].map((star) => <span key={star} className={star <= filled ? 'filled' : ''}>★</span>)}</span>;
}

function ProductDetailsPage({ auth, onSignIn, onAddToCart, onAddWishlistItem, onTrackViewed, wishlist, cart }) {
  const { productId = '' } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [imageIndex, setImageIndex] = useState(0);
  const [eligibility, setEligibility] = useState(null);
  const [reviewMessage, setReviewMessage] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [guidelinesOpen, setGuidelinesOpen] = useState(false);
  const [reviewFormOpen, setReviewFormOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [description, setDescription] = useState('');
  const [images, setImages] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState('');
  const [notifyError, setNotifyError] = useState('');
  const alreadyInWishlist = wishlist.some((item) => item.productType === 'product' && String(item.productId) === String(productId));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setData(null);
    setImageIndex(0);
    requestApi(`/api/products/${encodeURIComponent(productId)}`)
      .then((result) => { if (active) setData(result); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [productId]);

  const product = data?.product;
  useEffect(() => {
    if (product) onTrackViewed({ ...product, image: historyProductImage(product) });
  }, [productId, product, onTrackViewed]);
  const categoryImage = /sensor|module|driver/i.test(product?.category || '') ? productImages.sensor
    : /motor/i.test(product?.category || '') ? productImages.motor
      : /display|led|buzzer/i.test(product?.category || '') ? productImages.display
        : /wire|power|component/i.test(product?.category || '') ? productImages.wiring
          : productImages.board;
  const productImagesForView = product ? [...new Set([...(product.images || []), historyProductImage(product) || categoryImage])].filter(Boolean) : [];
  const currentImage = productImagesForView[imageIndex] || fallbackProductImage;
  const isOutOfStock = product?.status === 'Out of Stock' || product?.inventoryProduct && Number(product.stock) < 1;
  const inCart = cart.some((item) => String(item.id) === String(productId));

  const beginReview = async () => {
    setReviewError('');
    setReviewMessage('');
    setEligibility(null);
    if (!auth) { onSignIn(); return; }
    try {
      const result = await requestApi(`/api/products/${encodeURIComponent(productId)}/review-eligibility`);
      setEligibility(result);
      if (!result.eligible) setReviewError(result.message || 'You can only review products that you have purchased from Innovation Labs.');
      else setGuidelinesOpen(true);
    } catch (requestError) {
      setReviewError(requestError.message);
    }
  };

  const submitReview = async (event) => {
    event.preventDefault();
    if (rating < 1 || submitting) return;
    setSubmitting(true);
    setReviewError('');
    setReviewMessage('');
    try {
      const formData = new FormData();
      formData.append('rating', String(rating));
      formData.append('description', description);
      images.forEach((image) => formData.append('images', image));
      const response = await fetch(`/api/products/${encodeURIComponent(productId)}/reviews`, { method: 'POST', credentials: 'include', body: formData });
      const result = await parseJsonSafely(response);
      if (!response.ok) throw new Error(result?.message || 'Review could not be submitted.');
      setReviewFormOpen(false);
      setEligibility({ eligible: false, alreadyReviewed: true });
      setReviewMessage('Your review has been submitted successfully and is awaiting admin approval.');
      setRating(0);
      setDescription('');
      setImages([]);
    } catch (submitError) {
      setReviewError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const subscribeBackInStock = async () => {
    if (!auth) { onSignIn(); return; }
    setNotifying(true);
    setNotifyError('');
    setNotifyMessage('');
    try {
      const result = await requestApi(`/api/products/${encodeURIComponent(productId)}/back-in-stock`, { method: 'POST' });
      setNotifyMessage(result.message);
    } catch (notifyRequestError) {
      setNotifyError(notifyRequestError.message);
    } finally {
      setNotifying(false);
    }
  };

  if (loading) return <main className="page-shell"><div className="container"><div className="empty-state"><div className="spinner" /><p>Loading product details...</p></div></div></main>;
  if (error || !product) return <main className="page-shell"><div className="container"><div className="alert-box" role="alert">{error || 'Product was not found.'}</div><Link className="secondary-btn" to="/products">Back to Products</Link></div></main>;

  const summary = data.reviewSummary || { averageRating: 0, totalReviews: 0, distribution: [] };
  const productForAction = { ...product, image: currentImage, price: Number(product.price), inventoryProduct: Boolean(product.inventoryProduct) };
  return <main className="page-shell product-details-page">
    <div className="container">
      <nav className="product-breadcrumbs" aria-label="Breadcrumb"><Link to="/">Home</Link><span>›</span><Link to="/products">Products</Link><span>›</span><span aria-current="page">{product.name}</span></nav>
      <Link className="secondary-btn small product-back-button" to="/products">← Back to Products</Link>
      <section className="product-details-layout">
        <div className="product-details-gallery">
          <div className="product-details-image-frame"><img src={currentImage} alt={product.name} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} /></div>
          {productImagesForView.length > 1 && <div className="product-details-thumbnails" aria-label="Product images">{productImagesForView.map((image, index) => <button type="button" key={`${image}-${index}`} className={index === imageIndex ? 'active' : ''} onClick={() => setImageIndex(index)} aria-label={`Show product image ${index + 1}`}><img src={image} alt="" /></button>)}</div>}
        </div>
        <div className="product-details-info">
          <span className="tag">{product.category}</span>
          <h1>{product.name}</h1>
          <a className="product-rating-link" href="#customer-reviews"><ProductStars rating={summary.averageRating} /><strong>{summary.averageRating.toFixed(1)} / 5</strong><span>{summary.totalReviews} customer reviews</span></a>
          <strong className="product-details-price">₹{Number(product.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
          <span className={`product-details-stock ${isOutOfStock ? 'out-of-stock' : ''}`}>{isOutOfStock ? 'Out of Stock' : product.inventoryProduct && product.stock != null ? `${product.status} · ${product.stock} available` : 'In Stock'}</span>
          <p className="product-details-description">{product.description}</p>
          {Object.entries(product.technicalSpecs || {}).filter(([, value]) => value != null && String(value).trim()).length > 0 && <section className="product-specifications"><h2>Technical Specifications</h2><dl>{Object.entries(product.technicalSpecs).filter(([, value]) => value != null && String(value).trim()).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())}</dt><dd>{String(value)}</dd></div>)}</dl></section>}
          <div className="product-details-actions">
            {isOutOfStock ? <button className="primary-btn" disabled={notifying || Boolean(notifyMessage)} onClick={subscribeBackInStock}>{notifying ? 'Saving...' : notifyMessage ? 'Notification Set' : 'Notify Me When Available'}</button> : <button className="primary-btn" disabled={inCart || cart.some((item) => item.promoReservationId) || product.inventoryProduct && Number(product.stock) < 1} onClick={() => onAddToCart(productForAction)}>{inCart ? 'Added to Cart' : 'Add to Cart'}</button>}
            <button className="secondary-btn" disabled={alreadyInWishlist} onClick={() => onAddWishlistItem(productForAction, 'product')}>{alreadyInWishlist ? 'Added to Wishlist' : 'Add to Wishlist'}</button>
          </div>
          {notifyMessage && <p className="account-notice">{notifyMessage}</p>}{notifyError && <div className="alert-box" role="alert">{notifyError}</div>}
        </div>
      </section>
      <section className="customer-reviews-section" id="customer-reviews">
        <div className="section-title left"><span className="eyebrow">Customer feedback</span><h2>CUSTOMER REVIEWS</h2></div>
        <div className="review-summary-layout">
          <div className="review-average"><strong>{summary.averageRating.toFixed(1)}<small> / 5</small></strong><ProductStars rating={summary.averageRating} /><span>Average Rating</span><span>Total Reviews: {summary.totalReviews}</span></div>
          <div className="review-distribution">{[5, 4, 3, 2, 1].map((ratingValue) => {
            const row = summary.distribution.find((item) => item.rating === ratingValue) || { percentage: 0, count: 0 };
            return <div className="review-rating-bar" key={ratingValue}><span>{ratingValue} Stars</span><div><span style={{ width: `${row.percentage}%` }} /></div><small>{row.percentage}% · {row.count}</small></div>;
          })}</div>
        </div>
        <div className="customer-review-list">{data.reviews.length ? data.reviews.map((review) => <article className="customer-review-card" key={review.reviewId}>
          <div className="customer-review-heading"><strong>{review.customerName}</strong>{review.verifiedPurchase && <span className="verified-purchase-badge">✓ Verified Purchase</span>}<time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString('en-IN')}</time></div>
          <ProductStars rating={review.rating} label={`${review.rating} out of 5 stars`} />
          {review.description && <p>{review.description}</p>}
          {review.images.length > 0 && <div className="customer-review-images">{review.images.map((image, index) => <a href={image} target="_blank" rel="noreferrer" key={image}><img src={image} alt={`Customer review image ${index + 1}`} loading="lazy" /></a>)}</div>}
        </article>) : <p className="account-empty">No approved reviews yet. Be the first to share your experience.</p>}</div>
        <section className="review-submission"><h3>Wanna give a review?</h3>{!eligibility?.alreadyReviewed && <button type="button" className="primary-btn small" onClick={beginReview}>YES</button>}{reviewMessage && <div className="account-notice" role="status">{reviewMessage}</div>}{reviewError && <div className="alert-box" role="alert">{reviewError}</div>}</section>
      </section>
      {guidelinesOpen && <div className="wallet-lock-overlay"><section className="wallet-pin-modal product-review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-guidelines-title"><h2 id="review-guidelines-title">Community Guidelines</h2><p>Before submitting your review, please follow our community guidelines.</p><ul><li>Do not use abusive language.</li><li>Do not use offensive or insulting words.</li><li>Do not upload inappropriate images.</li><li>Submit genuine reviews about your purchased product.</li></ul><p>Reviews that violate these guidelines may be rejected by the administration team.</p><div className="modal-actions"><button type="button" className="primary-btn" onClick={() => { setGuidelinesOpen(false); setReviewFormOpen(true); }}>OK</button></div></section></div>}
      {reviewFormOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal product-review-dialog product-review-form" onSubmit={submitReview}><h2>Write Your Review</h2><p className="product-review-order">Verified order #{eligibility?.orderId}</p><fieldset><legend>Star Rating <span aria-hidden="true">*</span></legend><div className="review-star-picker" role="radiogroup" aria-label="Star rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" role="radio" aria-checked={rating === value} aria-label={`${value} star${value === 1 ? '' : 's'}`} className={value <= rating ? 'selected' : ''} key={value} onClick={() => setRating(value)}>★</button>)}</div></fieldset><label>Write Your Review <span>(optional)</span><textarea value={description} maxLength={2000} rows={5} onChange={(event) => setDescription(event.target.value)} placeholder="Share your experience with this product" /></label><label>Upload Images <span>(optional · up to 5 JPEG, PNG, or WebP files, 2 MB each)</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { const selected = [...(event.target.files || [])]; if (selected.length > 5 || selected.some((file) => file.size > 2 * 1024 * 1024)) { setReviewError('Choose up to 5 images, each 2 MB or smaller.'); event.target.value = ''; setImages([]); return; } setReviewError(''); setImages(selected); }} /></label>{reviewError && <div className="alert-box" role="alert">{reviewError}</div>}<div className="modal-actions"><button type="button" className="secondary-btn" disabled={submitting} onClick={() => setReviewFormOpen(false)}>Cancel</button><button className="primary-btn" disabled={submitting || rating < 1}>{submitting ? 'Submitting...' : 'Submit Review'}</button></div></form></div>}
    </div>
  </main>;
}

function CartPage({ cart, cartError, appliedDiscount, onApplyDiscount, onDiscountValidated, onRemoveDiscount, onRemove, onQty, onMoveToWishlist, onCheckout }) {
  const [discountInput, setDiscountInput] = useState('');
  const [discountError, setDiscountError] = useState('');
  const [discountBusy, setDiscountBusy] = useState(false);
  const cartValidationKey = cart.map((item) => `${item.id}:${item.price}:${item.quantity}:${item.category}`).join('|');
  const promoOnly = cart.length > 0 && cart.every((item) => Boolean(item.promoReservationId));
  const digitalOnly = cart.length > 0 && cart.every((item) => Boolean(item.promoReservationId || item.discountOfferId));
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const physicalSubtotal = cart.reduce((sum, item) => sum + (item.promoReservationId || item.discountOfferId ? 0 : item.price * item.quantity), 0);
  const deliveryCharge = deliveryFor(physicalSubtotal);
  const discountAmount = Number(appliedDiscount?.discountAmount || 0);
  const total = Math.max(0, subtotal + deliveryCharge - discountAmount);

  useEffect(() => {
    if (!appliedDiscount?.code) return undefined;
    let active = true;
    requestApi('/api/discount-codes/validate', {
      method: 'POST',
      body: JSON.stringify({ code: appliedDiscount.code, items: cart }),
    }).then((result) => {
      if (active) onDiscountValidated(result);
    }).catch((error) => {
      if (!active) return;
      onRemoveDiscount();
      setDiscountError(error.message || 'Invalid promo code. Please check your code and try again.');
    });
    return () => { active = false; };
  }, [cartValidationKey, appliedDiscount?.code]);

  const applyDiscount = async (event) => {
    event.preventDefault();
    if (!discountInput.trim() || discountBusy) return;
    setDiscountBusy(true);
    setDiscountError('');
    try {
      await onApplyDiscount(discountInput.trim());
      setDiscountInput('');
    } catch (error) {
      setDiscountError(error.message || 'Invalid promo code. Please check your code and try again.');
    } finally {
      setDiscountBusy(false);
    }
  };

  return (
    <main className="page-shell">
      <div className="container">
        <div className="section-title left">
          <span className="eyebrow">Your cart</span>
          <h2>{cart.length ? 'Selected Items' : 'Your cart is waiting for your next project.'}</h2>
        </div>
        {cartError && <div className="alert-box" role="alert">{cartError}</div>}

        {cart.length === 0 ? (
          <div className="cart-empty-layout">
            <section className="cart-empty-main">
              <div className="empty-cart-art" aria-hidden="true">
                <div className="empty-cart-board"><span /><span /><span /><span /></div>
                <div className="empty-cart-wire wire-one" />
                <div className="empty-cart-wire wire-two" />
                <div className="empty-cart-node node-one" />
                <div className="empty-cart-node node-two" />
              </div>
              <h3>Ready to build something?</h3>
              <p>Add Arduino boards, sensors, motors, displays, and other components to start building.</p>
              <Link className="primary-btn" to="/products">Browse Products</Link>
            </section>
            <aside className="cart-benefits">
              <h3>Why shop with Innovation Labs?</h3>
              <p><span aria-hidden="true">✓</span> Arduino-focused components</p>
              <p><span aria-hidden="true">✓</span> Custom order support</p>
              <p><span aria-hidden="true">✓</span> Secure checkout</p>
              <p><span aria-hidden="true">✓</span> Delivery tracking</p>
            </aside>
          </div>
        ) : (
          <div className="cart-layout">
            <div className="cart-items">
              <div className="cart-column-title">Selected Items <span>{cart.length} product{cart.length === 1 ? '' : 's'}</span></div>
              {cart.map((item) => (
                <div className="cart-item" key={item.id}>
                  <img src={item.image || fallbackProductImage} alt={item.name} onError={(event) => {
                    event.currentTarget.onerror = null;
                    event.currentTarget.src = fallbackProductImage;
                  }} />
                  <div className="item-meta">
                    <h3>{item.name}</h3>
                    <span>{item.category}</span>
                    {item.promoReservationId ? <><p>Digital Wallet Credit</p><p>Wallet Value: ₹{Number(item.price).toLocaleString('en-IN')}</p><span className={`promo-purchase-badge ${item.purchaseType}`}>{item.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</span><span className={`promo-recipient-badge ${item.recipientType === 'gift' ? 'gift' : ''}`}>{item.recipientType === 'gift' ? 'GIFT PURCHASE' : 'FOR MYSELF'}</span><p>Promo Code: Hidden until fulfillment</p></> : item.discountOfferId ? <p>{item.discountLabel || 'Discount offer'} · ₹{Number(item.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} each · Digital delivery, no shipping</p> : <p>₹{item.price} each</p>}
                    <button className="wishlist-move-button" onClick={() => onMoveToWishlist(item)}>Move to Wishlist</button>
                  </div>
                  {item.promoReservationId ? <div className="qty-box digital-quantity"><span>Quantity 1</span></div> : <div className="qty-box">
                    <button aria-label={`Decrease ${item.name} quantity`} onClick={() => onQty(item.id, -1)}>-</button>
                    <span>{item.quantity}</span>
                    <button aria-label={`Increase ${item.name} quantity`} disabled={item.quantity >= maxCartQuantity(item)} onClick={() => onQty(item.id, 1)}>+</button>
                  </div>}
                  <div className="item-total"><small>Item subtotal</small>₹{item.price * item.quantity}</div>
                  <button className="remove-link" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name}`}>Remove</button>
                </div>
              ))}
            </div>

            <aside className="summary-card">
              <h3>Order Summary</h3>
              <div className="summary-row"><span>Subtotal</span><strong>₹{subtotal}</strong></div>
              {appliedDiscount && <div className="summary-row cart-discount-summary"><span>Discount Promo Code ({appliedDiscount.code})</span><strong>−₹{discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}<button type="button" className="cart-discount-remove" onClick={() => { onRemoveDiscount(); setDiscountError(''); }}>Remove</button></strong></div>}
              {physicalSubtotal > 0 && <div className="summary-row"><span>Delivery</span><strong>{deliveryCharge ? `₹${deliveryCharge}` : 'FREE'}</strong></div>}
              <div className="summary-row total"><span>Total</span><strong>₹{total}</strong></div>
              {!digitalOnly && <section className="cart-discount-entry"><h4>Do you have a promo code?</h4>{appliedDiscount ? <p>{appliedDiscount.discountLabel} applied</p> : <form onSubmit={applyDiscount}><input value={discountInput} onChange={(event) => setDiscountInput(event.target.value.toUpperCase())} placeholder="Enter your discount promo code" aria-label="Enter your discount promo code" maxLength={19} /><button type="submit" aria-label="Apply promo code" disabled={discountBusy || !discountInput.trim()}>{discountBusy ? '…' : '→'}</button></form>}{discountError && <small role="alert">{discountError}</small>}</section>}
              {physicalSubtotal > 0 && <p className="delivery-note">Delivery is ₹40 for orders up to ₹800. Free delivery on orders above ₹800.</p>}
              <button className="primary-btn full" onClick={onCheckout}>{promoOnly ? 'Continue to Secure Payment' : 'Proceed to Checkout'}</button>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}

function PromoCodePaymentPage({ auth, address, setAddress, savedAddresses, saveAddress, savePromoRecipientAddress, nextPromoReservationId, onPurchased }) {
  const { reservationId } = useParams();
  const navigate = useNavigate();
  const [reservation, setReservation] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [success, setSuccess] = useState(null);
  const [copyState, setCopyState] = useState('Copy Code');
  const [view, setView] = useState('payment');
  const [deliveryAddress, setDeliveryAddress] = useState({ ...initialAddress });
  const [buyerDeliveryAddress, setBuyerDeliveryAddress] = useState({ ...initialAddress, ...address });
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientVerified, setRecipientVerified] = useState(false);
  const [recipientVerifyBusy, setRecipientVerifyBusy] = useState(false);
  const [offlineAddressStep, setOfflineAddressStep] = useState('buyer');
  const [addressErrors, setAddressErrors] = useState({});
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const [useNewAddress, setUseNewAddress] = useState(false);
  const savedAddress = savedAddresses?.[auth.email];
  const storedRecipientAddresses = savedAddresses?.[`${auth.email}::promo-recipient-addresses`];
  const savedRecipientAddresses = Array.isArray(storedRecipientAddresses) ? storedRecipientAddresses : [];
  const idempotencyKey = useRef(globalThis.crypto?.randomUUID?.() || `promo-pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setReservation(null);
    setSuccess(null);
    setView('payment');
    requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}`).then((result) => {
      if (!active) return;
      setReservation(result);
      setPaymentMethod(result.paymentMethod || '');
      setWalletBalance(result.walletBalance);
      setRecipientEmail(result.giftRecipientEmail || '');
      setRecipientVerified(Boolean(result.giftRecipientEmail) && result.recipientType === 'gift' && result.purchaseType === 'online');
      setDeliveryAddress(result.purchaseType === 'offline' && result.recipientType === 'gift'
        ? { ...initialAddress }
        : { ...initialAddress, ...address });
      setBuyerDeliveryAddress({ ...initialAddress, ...address });
      setAddressConfirmed(false);
      setOfflineAddressStep('buyer');
      setUseNewAddress(false);
      setAddressErrors({});
      if (['pending_approval', 'purchased', 'used'].includes(result.status) && result.order) {
        const savedOrder = onPurchased(result.order, result.reservationId);
        navigate('/order-placed', { state: { order: savedOrder } });
        return;
      }
    }).catch((requestError) => {
      if (active) setError(requestError.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reservationId]);

  useEffect(() => {
    if (view !== 'success-loading') return undefined;
    const timer = setTimeout(() => setView('success'), 800);
    return () => clearTimeout(timer);
  }, [view]);

  const choosePayment = async (method) => {
    if (busy || !reservation || method === paymentMethod) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}/payment-method`, { method: 'PATCH', body: JSON.stringify({ paymentMethod: method }) });
      setPaymentMethod(result.paymentMethod);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const finishPurchase = (result) => {
    const savedOrder = onPurchased(result.order, reservationId);
    setPinOpen(false);
    setPin('');
    navigate('/order-placed', { state: { order: savedOrder } });
  };

  const verifyGiftRecipient = async () => {
    if (busy || recipientVerifyBusy) return;
    setRecipientVerifyBusy(true);
    setError('');
    try {
      const result = await requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}/recipient`, {
        method: 'POST',
        body: JSON.stringify({ email: recipientEmail }),
      });
      setRecipientEmail(result.email);
      setRecipientVerified(true);
    } catch (requestError) {
      setRecipientVerified(false);
      setError(requestError.message);
    } finally {
      setRecipientVerifyBusy(false);
    }
  };

  const confirmDeliveryAddress = async () => {
    const choosingBuyerAddress = reservation?.recipientType === 'gift' && offlineAddressStep === 'buyer';
    const addressToValidate = choosingBuyerAddress ? buyerDeliveryAddress : deliveryAddress;
    const nextErrors = {};
    ['fullName', 'phoneNumber', 'addressLine1', 'city', 'state', 'pinCode', 'country'].forEach((field) => {
      if (!String(addressToValidate[field] || '').trim()) nextErrors[field] = 'This field is required.';
    });
    setAddressErrors(nextErrors);
    if (Object.keys(nextErrors).length) return false;
    if (choosingBuyerAddress) {
      if (!await saveAddress(buyerDeliveryAddress)) {
        setError('The buyer address could not be saved. Please retry before continuing.');
        return false;
      }
      setAddress(buyerDeliveryAddress);
      setDeliveryAddress({ ...initialAddress });
      setOfflineAddressStep('recipient');
      setUseNewAddress(true);
      return true;
    }
    if (reservation?.recipientType === 'gift') {
      try {
        await savePromoRecipientAddress({ ...deliveryAddress });
      } catch (requestError) {
        setError(`The recipient address could not be saved: ${requestError.message}`);
        return false;
      }
    } else if (reservation?.recipientType === 'myself') {
      if (!await saveAddress(deliveryAddress)) {
        setError('The delivery address could not be saved. Please retry before continuing.');
        return false;
      }
      setAddress(deliveryAddress);
    }
    setAddressConfirmed(true);
    return true;
  };

  const payWallet = async (event) => {
    event.preventDefault();
    if (busy || pin.length !== 4) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}/pay-wallet`, { method: 'POST', body: JSON.stringify({
        pin,
        idempotencyKey: idempotencyKey.current,
        address: reservation.purchaseType === 'offline' ? deliveryAddress : undefined,
        recipientAddress: reservation.purchaseType === 'offline' ? deliveryAddress : undefined,
        buyerAddress: reservation.purchaseType === 'offline' && reservation.recipientType === 'gift' ? buyerDeliveryAddress : undefined,
        recipientEmail: reservation.recipientType === 'gift' ? recipientEmail : undefined,
      }) });
      setWalletBalance(result.wallet.balance);
      finishPurchase(result);
    } catch (requestError) {
      setPin('');
      setError(requestError.message || 'Wallet payment could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const payRazorpay = async () => {
    if (busy || !window.Razorpay) {
      if (!window.Razorpay) setError('Razorpay checkout could not load. Please retry.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const paymentOrder = await requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}/razorpay/order`, {
        method: 'POST',
        body: JSON.stringify({
          address: reservation.purchaseType === 'offline' ? deliveryAddress : undefined,
          recipientAddress: reservation.purchaseType === 'offline' ? deliveryAddress : undefined,
          buyerAddress: reservation.purchaseType === 'offline' && reservation.recipientType === 'gift' ? buyerDeliveryAddress : undefined,
          recipientEmail: reservation.recipientType === 'gift' ? recipientEmail : undefined,
        }),
      });
      const checkout = new window.Razorpay({
        key: paymentOrder.keyId,
        order_id: paymentOrder.orderId,
        amount: paymentOrder.amountPaise,
        currency: 'INR',
        name: 'Innovation Labs',
        description: 'Digital Wallet Credit',
        theme: { color: '#00d1ff' },
        handler: async (response) => {
          setError('');
          try {
            const result = await requestApi(`/api/promo-codes/reservations/${encodeURIComponent(reservationId)}/razorpay/verify`, { method: 'POST', body: JSON.stringify(response) });
            finishPurchase(result);
          } catch (verifyError) {
            setError(verifyError.message || 'Payment could not be verified. No Promo Code was issued.');
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      checkout.open();
    } catch (requestError) {
      setError(requestError.message);
      setBusy(false);
    }
  };

  const copyPromoCode = async () => {
    try {
      await navigator.clipboard.writeText(success.promoCode.code);
      setCopyState('Copied!');
      setTimeout(() => setCopyState('Copy Code'), 1800);
    } catch {
      setError('Clipboard access is unavailable. Select and copy the Promo Code.');
    }
  };

  const continueToOrder = () => nextPromoReservationId
    ? navigate(`/products/promo-codes/payment/${encodeURIComponent(nextPromoReservationId)}`)
    : navigate('/order-placed', { state: { order: success.order } });

  if (loading) return <main className="page-shell"><div className="container loader-wrap"><div className="spinner" /><p>Loading secure payment...</p></div></main>;
  if (error && !reservation && !success) return <main className="page-shell"><div className="container narrow-container"><div className="alert-box">{error}</div><Link className="secondary-btn" to="/products">Return to Products</Link></div></main>;
  if (view === 'success' && success) return null;
  if (reservation?.purchaseType === 'online' && reservation.recipientType === 'gift' && !recipientVerified) return <GiftRecipientStep email={recipientEmail} busy={recipientVerifyBusy} error={error} onEmailChange={(value) => { setRecipientEmail(value); setRecipientVerified(false); setError(''); }} onContinue={verifyGiftRecipient} />;
  if (reservation?.purchaseType === 'offline' && !addressConfirmed) return <OfflinePromoAddressStep
    recipientType={reservation.recipientType || 'myself'}
    step={offlineAddressStep}
    address={deliveryAddress}
    buyerAddress={buyerDeliveryAddress}
    savedAddress={savedAddress}
    savedRecipientAddresses={savedRecipientAddresses}
    useNewAddress={useNewAddress}
    recipientEmail={recipientEmail}
    errors={addressErrors}
    onUseSaved={(selectedAddress) => { const saved = { ...initialAddress, ...selectedAddress }; if (reservation.recipientType === 'gift' && offlineAddressStep === 'buyer') setBuyerDeliveryAddress(saved); else setDeliveryAddress(saved); setUseNewAddress(false); setAddressErrors({}); }}
    onUseNew={() => { const buyerStep = reservation.recipientType === 'gift' && offlineAddressStep === 'buyer'; const current = buyerStep ? buyerDeliveryAddress : reservation.recipientType === 'gift' ? initialAddress : deliveryAddress; const nextAddress = { ...initialAddress, ...current }; if (buyerStep) setBuyerDeliveryAddress(nextAddress); else setDeliveryAddress(nextAddress); setUseNewAddress(true); setAddressErrors({}); }}
    onBuyerAddressChange={(field, value) => setBuyerDeliveryAddress((current) => ({ ...current, [field]: value }))}
    onAddressChange={(field, value) => setDeliveryAddress((current) => ({ ...current, [field]: value }))}
    onRecipientEmailChange={setRecipientEmail}
    onContinue={confirmDeliveryAddress}
  />;

  return <main className="page-shell promo-payment-page"><div className="container narrow-container">
    {view === 'success-loading' ? <div className="promo-payment-processing" role="status"><div className="order-buffer-spinner" /><p>Verifying your purchase...</p></div> : view === 'success' && success ? <section className="promo-payment-success"><div className="order-success-circle is-visible" aria-hidden="true"><span className="order-checkmark" /></div><h1>Promo Code Purchased</h1><p>Your Promo Code has been successfully purchased.</p><strong>₹{success.promoCode.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong><p>{success.promoCode.code}</p></section> : reservation && <>
      <Link className="back-link" to="/cart">← Back to Cart</Link>
      <header className="promo-payment-heading"><span className="eyebrow">{reservation.purchaseType === 'offline' ? 'Offline purchase' : 'Online purchase'}{reservation.recipientType === 'gift' ? ' · Gift' : ''}</span><h1>Secure Payment</h1><p>{reservation.recipientType === 'gift' ? `Promo Code gift for ${reservation.giftRecipientEmail || recipientEmail}` : 'Promo Code purchase'}</p></header>
      {error && <div className="alert-box" role="alert">{error}</div>}
      {reservation.purchaseType === 'offline' && <PromoOfflineOrderSummary amount={reservation.promoCode.amount} buyer={auth} buyerAddress={reservation.recipientType === 'gift' ? buyerDeliveryAddress : null} recipientAddress={deliveryAddress} recipientType={reservation.recipientType} recipientEmail={recipientEmail} />}
      <section className="promo-payment-card"><div className="promo-payment-code"><span>Promo Code</span><strong>Hidden until purchase</strong></div><div className="promo-payment-value"><span>Wallet Value</span><strong>₹{reservation.promoCode.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div><div className="promo-payment-methods"><strong>Payment Method</strong><label><input type="radio" name="promo-payment-method" checked={paymentMethod === 'Wallet'} disabled={busy} onChange={() => choosePayment('Wallet')} /> Wallet</label><label><input type="radio" name="promo-payment-method" checked={paymentMethod === 'Razorpay'} disabled={busy} onChange={() => choosePayment('Razorpay')} /> Razorpay / Online Payment</label></div>{paymentMethod === 'Wallet' && <div className="promo-payment-wallet"><div><span>Wallet Balance</span><strong>{walletBalance == null ? 'Available after authorization' : `₹${walletBalance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}</strong></div><div><span>Promo Code Value</span><strong>₹{reservation.promoCode.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>{walletBalance != null && <div><span>Remaining Wallet Balance</span><strong>₹{Math.max(0, walletBalance - reservation.promoCode.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>}</div>}<div className="promo-payment-total"><span>Total</span><strong>₹{reservation.promoCode.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>{paymentMethod === 'Wallet' ? <><p className="promo-pin-note">Your 4-digit Wallet PIN will be required to authorize this payment.</p><button className="primary-btn full" disabled={busy} onClick={() => setPinOpen(true)}>Continue Payment</button></> : paymentMethod === 'Razorpay' ? <button className="primary-btn full" disabled={busy} onClick={payRazorpay}>{busy ? 'Preparing secure payment...' : 'Continue Payment'}</button> : <button className="primary-btn full" disabled>Choose a payment method</button>}</section>
    </>}
    {pinOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal transfer-pin-modal" role="dialog" aria-modal="true" aria-labelledby="promo-pin-title" onSubmit={payWallet}><h2 id="promo-pin-title">Wallet Security</h2><p>Enter your 4-digit Wallet PIN to authorize this Promo Code purchase.</p><PinBoxes value={pin} onChange={(value) => { setPin(value); setError(''); }} disabled={busy} />{error && <p className="voice-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-btn" disabled={busy} onClick={() => { setPinOpen(false); setPin(''); }}>Cancel</button><button className="primary-btn" disabled={busy || pin.length !== 4}>{busy ? 'Processing payment...' : 'Confirm Payment'}</button></div></form></div>}
    {success && view === 'success' && <div className="wallet-lock-overlay"><section className="wallet-pin-modal promo-code-purchased-modal" role="dialog" aria-modal="true" aria-labelledby="promo-purchased-title"><h2 id="promo-purchased-title">Promo Code Purchased</h2><code>{success.promoCode.code}</code><button className="secondary-btn" onClick={copyPromoCode}>{copyState}</button><button className="primary-btn full" onClick={continueToOrder}>OK</button></section></div>}
  </div></main>;
}

function GiftRecipientStep({ email, busy, error, onEmailChange, onContinue }) {
  return <main className="page-shell promo-payment-page"><div className="container narrow-container">
    <Link className="back-link" to="/cart">← Back to Cart</Link>
    <header className="promo-payment-heading"><span className="eyebrow">Digital gift</span><h1>Who are you sending this promo code to?</h1><p>Enter the recipient's registered Innovation Labs email address.</p></header>
    <section className="promo-payment-card gift-recipient-step"><label>Recipient Email<input type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="recipient@example.com" autoComplete="email" required /></label><p>The promo code will be assigned to the recipient's account. Their account details remain private.</p>{error && <div className="alert-box" role="alert">{error}</div>}<button className="primary-btn full" type="button" disabled={busy || !email.trim()} onClick={onContinue}>{busy ? 'Verifying recipient...' : 'Verify Recipient & Continue'}</button></section>
  </div></main>;
}

function PromoOfflineOrderSummary({ amount, buyer, buyerAddress, recipientAddress, recipientType, recipientEmail }) {
  const addressText = (value) => [value?.fullName, value?.phoneNumber, value?.addressLine1, value?.addressLine2, value?.city, value?.state, value?.pinCode, value?.country, value?.deliveryInstructions].filter(Boolean).join(', ');
  return <section className="promo-payment-card promo-checkout-order-summary"><h2>Offline Order Summary</h2>
    <dl className="order-information-list"><div><dt>Buyer</dt><dd>{buyer.name} · {buyer.email}</dd></div><div><dt>Promo Code Product</dt><dd>Digital Wallet Credit × 1</dd></div><div><dt>Wallet Credit Value</dt><dd>₹{Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Product Price</dt><dd>₹{Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Delivery Charges</dt><dd>Included</dd></div><div><dt>Final Amount</dt><dd>₹{Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>{recipientType === 'gift' && <div><dt>Gift Recipient</dt><dd>{recipientEmail || 'Recipient at delivery address'}</dd></div>}<div><dt>Buyer Contact Address</dt><dd>{addressText(buyerAddress || recipientAddress)}</dd></div><div><dt>Delivery Address</dt><dd>{addressText(recipientAddress)}</dd></div></dl>
  </section>;
}

function OfflinePromoAddressStep({ recipientType, step, address, buyerAddress, savedAddress, savedRecipientAddresses, useNewAddress, recipientEmail, errors, onUseSaved, onUseNew, onBuyerAddressChange, onAddressChange, onRecipientEmailChange, onContinue }) {
  const buyerStep = recipientType === 'gift' && step === 'buyer';
  const activeAddress = buyerStep ? buyerAddress : address;
  const onChange = buyerStep ? onBuyerAddressChange : onAddressChange;
  const showSavedAddress = buyerStep || recipientType === 'myself';
  const sameAddress = (left, right) => ['fullName', 'phoneNumber', 'addressLine1', 'addressLine2', 'city', 'state', 'pinCode', 'country', 'deliveryInstructions'].every((field) => String(left?.[field] || '') === String(right?.[field] || ''));
  const recipientAddressChoices = [
    ...(savedAddress ? [{ key: 'account', label: 'Use saved account address', address: savedAddress }] : []),
    ...savedRecipientAddresses.map((saved, index) => ({ key: `recipient-${index}`, label: 'Use saved recipient address', address: saved })),
  ];
  const fields = [
    ['fullName', buyerStep ? "Buyer's Full Name" : 'Full Name'],
    ['phoneNumber', buyerStep ? "Buyer's Phone Number" : 'Phone Number'],
    ['addressLine1', 'House Number and Street'], ['addressLine2', 'Area / Locality'],
    ['city', 'City'], ['state', 'State'], ['pinCode', 'PIN Code'], ['country', 'Country'],
  ];
  return <main className="page-shell promo-payment-page"><div className="container narrow-container">
    <Link className="back-link" to="/cart">← Back to Cart</Link>
    <header className="promo-payment-heading"><span className="eyebrow">Offline purchase · {recipientType === 'gift' ? 'Gift Order' : 'For Myself'}</span><h1>{buyerStep ? "Buyer's Address" : recipientType === 'gift' ? "Recipient's Address" : 'Delivery Address'}</h1><p>{buyerStep ? 'Enter the buyer contact address, then add a separate delivery address.' : 'Confirm the delivery details before payment.'}</p></header>
    <section className="promo-payment-card promo-offline-address-card">
      {showSavedAddress && savedAddress && <div className="promo-address-choice"><button type="button" className={!useNewAddress ? 'selected' : ''} onClick={onUseSaved}><strong>Use saved address</strong><span>{[savedAddress.fullName, savedAddress.addressLine1, savedAddress.addressLine2, savedAddress.city, savedAddress.state, savedAddress.pinCode].filter(Boolean).join(', ')}</span></button><button type="button" className={useNewAddress ? 'selected' : ''} onClick={onUseNew}><strong>Add or edit address</strong><span>Use different contact or delivery details.</span></button></div>}
      {recipientType === 'gift' && !buyerStep && recipientAddressChoices.length > 0 && <div className="promo-address-choice">{recipientAddressChoices.map((choice) => <button key={choice.key} type="button" className={!useNewAddress && sameAddress(activeAddress, choice.address) ? 'selected' : ''} onClick={() => onUseSaved(choice.address)}><strong>{choice.label}</strong><span>{[choice.address.fullName, choice.address.phoneNumber, choice.address.addressLine1, choice.address.addressLine2, choice.address.city, choice.address.state, choice.address.pinCode].filter(Boolean).join(', ')}</span></button>)}<button type="button" className={useNewAddress ? 'selected' : ''} onClick={onUseNew}><strong>Add new recipient address</strong><span>Enter a different recipient's delivery details.</span></button></div>}
      {(!showSavedAddress || !savedAddress || useNewAddress) && <div className="promo-delivery-address-grid">{fields.map(([field, label]) => <label key={field} className={field === 'addressLine1' || field === 'addressLine2' ? 'full-width' : ''}>{label}<input required value={activeAddress?.[field] || ''} onChange={(event) => onChange(field, event.target.value)} />{errors[field] && <small>{errors[field]}</small>}</label>)}
        {recipientType === 'gift' && !buyerStep && <><label className="full-width">Recipient Email (optional)<input type="email" value={recipientEmail} onChange={(event) => onRecipientEmailChange(event.target.value)} placeholder="recipient@example.com" /></label><label className="full-width">Additional Delivery Instructions<textarea value={activeAddress?.deliveryInstructions || ''} onChange={(event) => onChange('deliveryInstructions', event.target.value)} /></label></>}
      </div>}
      <button className="primary-btn full" type="button" onClick={onContinue}>{buyerStep ? "Next: Recipient's Address" : 'Confirm Addresses & Continue to Payment'}</button>
    </section>
  </div></main>;
}

function PromoPurchaseSuccess({ success, nextPromoReservationId, onCopy, onContinue }) {
  const offline = success.order?.purchaseType === 'offline';
  const isGift = success.order?.recipientType === 'gift';
  return <main className="page-shell promo-payment-page"><div className="container narrow-container">
    <section className="promo-payment-success"><div className="order-success-circle is-visible" aria-hidden="true"><span className="order-checkmark" /></div>
      <h1>{offline ? 'Order Awaiting Approval' : isGift ? 'Gift Order Confirmed' : 'Promo Code Purchased'}</h1>
      <p>{offline ? 'Your payment is confirmed. The order is pending admin approval; the promo code and wallet credit will be activated after acceptance.' : isGift ? 'Your payment is confirmed and the gift is ready in the recipient\'s Wallet.' : 'Your Promo Code has been successfully purchased.'}</p>
      <strong>₹{Number(success.order?.total || success.promoCode?.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
      {success.order?.orderId && <p>Order #{success.order.orderId} · {success.order.orderStatus}</p>}
      {isGift && <dl className="promo-gift-order-facts"><div><dt>Purchase Type</dt><dd>{offline ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'} · GIFT</dd></div><div><dt>Buyer</dt><dd>{success.order.userName} · {success.order.userEmail}</dd></div><div><dt>Recipient</dt><dd>{success.order.recipientEmail || 'Recipient address'}</dd></div><div><dt>Promo Code Product</dt><dd>Digital Wallet Credit</dd></div><div><dt>Wallet Credit Value</dt><dd>₹{Number(success.order.promoCodeAmountPaise || 0) / 100}</dd></div><div><dt>Payment</dt><dd>{success.order.paymentMethod} · {success.order.paymentStatus}</dd></div><div><dt>Activation</dt><dd>{success.order.promoActivationStatus || 'Pending Admin Approval'}</dd></div><div><dt>Order Date</dt><dd>{new Date(success.order.createdAt).toLocaleString()}</dd></div></dl>}
      {success.promoCode?.code && <><p>{success.promoCode.code}</p><button className="secondary-btn" onClick={onCopy}>Copy Code</button></>}
      <button className="primary-btn" onClick={onContinue}>{nextPromoReservationId ? 'Continue to Next Promo Code' : 'View Order Details'}</button>
    </section>
  </div></main>;
}

function CheckoutPage({ auth, cart, selectedService, setSelectedService, projectPreferences, setProjectPreferences, address, setAddress, saveAddress, checkoutStep, setCheckoutStep, onOpenProjectModal, onPay, onWalletPay, paymentTotal, appliedDiscount, codingCharge, buildingCharge, deliveryCharge, subtotal, handlePlaceOrder, onLogin, savedAddresses, authEmail }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [errors, setErrors] = useState({});
  const [paymentMethod, setPaymentMethod] = useState('online');
  const [walletQuote, setWalletQuote] = useState(null);
  const [walletQuoteError, setWalletQuoteError] = useState('');
  const [walletQuoteLoading, setWalletQuoteLoading] = useState(false);

  const hasCoding = selectedService === 'coding' || selectedService === 'full';
  const hasBuilding = selectedService === 'building' || selectedService === 'full';
  const digitalOnly = cart.length > 0 && cart.every((item) => Boolean(item.discountOfferId));
  const displayedCheckoutStep = digitalOnly ? 3 : checkoutStep;
  const serviceIndex = serviceOptions.findIndex((option) => option.id === selectedService);
  const currentAddress = auth && authEmail ? savedAddresses[authEmail] || address : address;

  useEffect(() => {
    if (location.state?.aiPaymentMethod === 'Wallet') setPaymentMethod('wallet');
    if (location.state?.aiPaymentMethod === 'Online Payment') setPaymentMethod('online');
  }, [location.state?.aiPaymentMethod]);

  useEffect(() => {
    if (auth && savedAddresses[auth.email]) {
      setAddress({ ...savedAddresses[auth.email] });
    }
  }, [auth, savedAddresses, setAddress]);

  useEffect(() => {
    if (digitalOnly && checkoutStep !== 3) setCheckoutStep(3);
  }, [digitalOnly, checkoutStep, setCheckoutStep]);

  useEffect(() => {
    if (!auth || paymentMethod !== 'wallet') return undefined;
    let active = true;
    setWalletQuoteLoading(true);
    setWalletQuoteError('');
    requestApi('/api/wallet/quote', {
      method: 'POST',
      body: JSON.stringify({ items: cart, service: selectedService, discountCode: appliedDiscount?.code }),
    }).then((quote) => {
      if (active) setWalletQuote(quote);
    }).catch((error) => {
      if (active) {
        setWalletQuote(null);
        setWalletQuoteError(error.message);
      }
    }).finally(() => {
      if (active) setWalletQuoteLoading(false);
    });
    return () => { active = false; };
  }, [auth, cart, paymentMethod, selectedService, appliedDiscount?.code]);

  if (!auth) {
    return (
      <main className="page-shell">
        <div className="container centered-box">
          <div className="empty-state">
            <h3>Please sign in to continue checkout.</h3>
            <button className="primary-btn" onClick={onLogin}>Continue with Google</button>
          </div>
        </div>
      </main>
    );
  }

  const validateAddress = () => {
    const nextErrors = {};
    if (!address.fullName.trim()) nextErrors.fullName = 'Full name is required.';
    if (!address.phoneNumber.trim()) nextErrors.phoneNumber = 'Phone number is required.';
    if (!address.addressLine1.trim()) nextErrors.addressLine1 = 'Address line 1 is required.';
    if (!address.city.trim()) nextErrors.city = 'City is required.';
    if (!address.state.trim()) nextErrors.state = 'State is required.';
    if (!address.pinCode.trim()) nextErrors.pinCode = 'PIN/ZIP code is required.';
    if (!address.country.trim()) nextErrors.country = 'Country is required.';
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const nextStep = async () => {
    if (checkoutStep === 1) {
      if (hasCoding || hasBuilding) {
        onOpenProjectModal();
        return;
      }
      setCheckoutStep(2);
      return;
    }

    if (checkoutStep === 2) {
      if (validateAddress()) {
        if (!await saveAddress(address)) return;
        setCheckoutStep(3);
      }
    }
  };

  return (
    <main className="page-shell">
      <div className="container checkout-shell">
        <div className="checkout-header">
          <span className="eyebrow">Secure checkout</span>
          <h2>Place your order</h2>
        </div>

        <div className="progress-steps">
          {(digitalOnly ? [3, 4] : [1, 2, 3, 4]).map((step) => (
            <div key={step} className={`step ${displayedCheckoutStep >= step ? 'active' : ''}`}>
              {step === 1 && 'Project Preferences'}
              {step === 2 && 'Address'}
              {step === 3 && 'Payment'}
              {step === 4 && 'Confirmation'}
            </div>
          ))}
        </div>

        {displayedCheckoutStep === 1 && (
          <div className="checkout-card">
            <h3>Step 1 — Project Preferences</h3>
            <div className="service-slider-wrap">
              <label htmlFor="service-slider" className="service-slider-label">Project service level</label>
              <input
                id="service-slider"
                type="range"
                min="0"
                max={serviceOptions.length - 1}
                step="1"
                value={Math.max(0, serviceIndex)}
                onChange={(event) => setSelectedService(serviceOptions[Number(event.target.value)].id)}
                className="service-slider"
              />
              <div className="service-slider-values">
                {serviceOptions.map((option) => (
                  <span key={option.id} className={selectedService === option.id ? 'active' : ''}>{option.title}</span>
                ))}
              </div>
            </div>

            <div className="service-grid">
              {serviceOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={`service-option ${selectedService === option.id ? 'selected' : ''}`}
                  onClick={() => setSelectedService(option.id)}
                >
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>

            <div className="project-summary">
              <span>Selected service: <strong>{serviceOptions.find((item) => item.id === selectedService)?.title}</strong></span>
              {projectPreferences && <p>Project brief: {projectPreferences}</p>}
            </div>

            <div className="checkout-actions">
              <button className="primary-btn" onClick={nextStep}>Next</button>
            </div>
          </div>
        )}

        {displayedCheckoutStep === 2 && (
          <div className="checkout-card">
            <h3>Step 2 — Address</h3>
            <div className="address-grid">
              <label>
                Full Name
                <input value={address.fullName} onChange={(e) => setAddress({ ...address, fullName: e.target.value })} />
                {errors.fullName && <small>{errors.fullName}</small>}
              </label>
              <label>
                Phone Number
                <input value={address.phoneNumber} onChange={(e) => setAddress({ ...address, phoneNumber: e.target.value })} />
                {errors.phoneNumber && <small>{errors.phoneNumber}</small>}
              </label>
              <label className="full-width">
                Address Line 1
                <input value={address.addressLine1} onChange={(e) => setAddress({ ...address, addressLine1: e.target.value })} />
                {errors.addressLine1 && <small>{errors.addressLine1}</small>}
              </label>
              <label className="full-width">
                Address Line 2
                <input value={address.addressLine2} onChange={(e) => setAddress({ ...address, addressLine2: e.target.value })} />
              </label>
              <label>
                City
                <input value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
                {errors.city && <small>{errors.city}</small>}
              </label>
              <label>
                State
                <input value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
                {errors.state && <small>{errors.state}</small>}
              </label>
              <label>
                PIN/ZIP Code
                <input value={address.pinCode} onChange={(e) => setAddress({ ...address, pinCode: e.target.value })} />
                {errors.pinCode && <small>{errors.pinCode}</small>}
              </label>
              <label>
                Country
                <input value={address.country} onChange={(e) => setAddress({ ...address, country: e.target.value })} />
                {errors.country && <small>{errors.country}</small>}
              </label>
            </div>

            <div className="checkout-actions space-between">
              <button className="secondary-btn" onClick={() => setCheckoutStep(1)}>Back</button>
              <button className="primary-btn" onClick={nextStep}>Next</button>
            </div>
          </div>
        )}

        {displayedCheckoutStep === 3 && (
          <div className="checkout-card">
            <h3>Step 3 — Payment</h3>
            <div className="payment-methods">
              <strong>Payment Method</strong>
              <label><input type="radio" name="payment-method" checked={paymentMethod === 'online'} onChange={() => setPaymentMethod('online')} /> Online Payment</label>
              <label><input type="radio" name="payment-method" checked={paymentMethod === 'wallet'} onChange={() => setPaymentMethod('wallet')} /> Wallet</label>
            </div>
            {paymentMethod === 'wallet' && <section className="wallet-checkout-summary">
              <h4>Wallet Payment</h4>
              {walletQuoteLoading ? <p>Checking wallet balance...</p> : walletQuoteError ? <><p>{walletQuoteError}</p><Link to="/wallet">Open Wallet</Link></> : walletQuote && <>
                <div className="summary-row"><span>Wallet Balance</span><strong>{walletQuote.balance == null ? 'Verify with PIN' : `₹${walletQuote.balance.toLocaleString('en-IN')}`}</strong></div>
                <div className="summary-row"><span>Order Total</span><strong>₹{walletQuote.total.toLocaleString('en-IN')}</strong></div>
                {walletQuote.balance != null && walletQuote.balance < walletQuote.total ? <><div className="summary-row"><span>Short by</span><strong>₹{(walletQuote.total - walletQuote.balance).toLocaleString('en-IN')}</strong></div><p className="wallet-insufficient">Insufficient wallet balance. Your order will not be placed.</p><Link className="secondary-btn small" to="/wallet">Recharge Wallet</Link></> : <div className="summary-row total"><span>Amount to Pay</span><strong>₹{walletQuote.total.toLocaleString('en-IN')}</strong></div>}
              </>}
            </section>}
            <div className="fee-list">
              <h4>Order Summary</h4>
              {cart.map((item) => (
                <div className="summary-row" key={item.id}>
                  <span>{item.name} × {item.quantity}</span>
                  <strong>₹{item.price * item.quantity}</strong>
                </div>
              ))}
            </div>
            <div className="fee-list">
              <div className="summary-row"><span>Product subtotal</span><strong>₹{subtotal}</strong></div>
              {appliedDiscount && <div className="summary-row cart-discount-summary"><span>Discount Promo Code ({appliedDiscount.code})</span><strong>−₹{Number(appliedDiscount.discountAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>}
              {codingCharge > 0 && <div className="summary-row"><span>Coding charge</span><strong>₹{codingCharge}</strong></div>}
              {buildingCharge > 0 && <div className="summary-row"><span>Building charge</span><strong>₹{buildingCharge}</strong></div>}
              {!digitalOnly && <div className="summary-row"><span>Delivery charge</span><strong>{deliveryCharge ? `₹${deliveryCharge}` : 'FREE'}</strong></div>}
              <div className="summary-row total"><span>Grand total</span><strong>₹{paymentTotal}</strong></div>
            </div>

            <div className="checkout-actions space-between">
              <button className="secondary-btn" onClick={() => digitalOnly ? navigate('/cart') : setCheckoutStep(2)}>Back</button>
              <div className="payment-actions">
                {paymentMethod === 'online' ? (
                  <button className="primary-btn" onClick={onPay}>Pay Online</button>
                ) : (
                  <button className="primary-btn" disabled={!walletQuote || walletQuoteLoading || (walletQuote.balance != null && walletQuote.balance < walletQuote.total)} onClick={onWalletPay}>Pay with Wallet</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

const accountSections = [
  ['overview', 'Overview'],
  ['plan', 'Plan'],
  ['ai-credits', 'AI Credits'],
  ['orders', 'My Orders'],
  ['wishlist', 'My Wishlist'],
  ['reward-points', 'Reward Points'],
  ['discount-codes', 'Discount Promo Codes'],
  ['scratch-cards', 'My Scratch Cards'],
  ['invoices', 'My Invoices'],
  ['history', 'Order History'],
  ['items', 'Total Items Ordered'],
  ['custom-orders', 'Custom Orders'],
  ['wallet', 'Wallet'],
  ['address', 'Saved Address'],
  ['notifications', 'Notifications'],
  ['settings', 'Account Settings'],
  ['sign-out', 'Sign Out'],
];

function AccountLoadingPage() {
  return <main className="page-shell"><div className="container centered-box"><div className="empty-state"><h3>Checking your account...</h3></div></div></main>;
}

function SignInRequiredPage({ onSignIn }) {
  return (
    <main className="page-shell">
      <div className="container centered-box">
        <div className="empty-state">
          <h3>Sign in to open your account.</h3>
          <button className="primary-btn" onClick={onSignIn}>Sign In</button>
        </div>
      </div>
    </main>
  );
}

function AccountPage({ user, accountData, orders, customOrders, notifications, address, wishlist, onAddWishlistItem, onRemoveWishlistItem, onAddWishlistPromoToCart, onAddToCart, onAddDiscountCodeToCart, loading, error, notice, onSaveAddress, onSavePhone, onMarkRead, onOrderCustomItem, onSignOut, onCancelOrder }) {
  const { section = 'overview' } = useParams();
  const activeSection = accountSections.some(([id]) => id === section) ? section : 'overview';
  const profile = accountData?.profile || user;
  const stats = accountData?.stats;
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState({ ...initialAddress });
  const [phoneNumber, setPhoneNumber] = useState(profile.phoneNumber || '');
  const [settingsError, setSettingsError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    setAddressDraft({ ...initialAddress, ...(address || {}) });
  }, [address]);

  useEffect(() => {
    setPhoneNumber(profile.phoneNumber || '');
  }, [profile.phoneNumber]);

  const itemCountFor = (order) => (order.items || []).reduce((sum, item) => sum + item.quantity, 0);
  const dateFor = (date) => date ? new Date(date).toLocaleDateString() : 'Date unavailable';
  const orderRows = orders.slice().sort((left, right) => new Date(right.date) - new Date(left.date));
  const currentCustomOrders = customOrders.slice().sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const addressLine = [address?.addressLine1, address?.addressLine2].filter(Boolean).join(', ');

  const savePhone = async (event) => {
    event.preventDefault();
    setSettingsError('');
    setSavingSettings(true);
    try {
      await onSavePhone(phoneNumber);
    } catch (saveError) {
      setSettingsError(saveError.message);
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <main className="page-shell account-page">
      <div className="container">
        <header className="account-heading">
          <span className="eyebrow">Customer account</span>
          <h1>Hello, {user.name.split(' ')[0]}</h1>
          <p>Manage your account, orders, and preferences.</p>
        </header>

        <div className="account-layout">
          <aside className="account-sidebar" aria-label="Account sections">
            {accountSections.map(([id, label]) => (
              <Link key={id} to={`/account/${id}`} className={activeSection === id ? 'active' : ''}>
                {id === 'sign-out' && <span aria-hidden="true">↪</span>}{label}
              </Link>
            ))}
          </aside>

          <section className="account-content">
            {notice && <div className="account-notice" role="status">{notice}</div>}
            {error && <div className="alert-box" role="alert">{error}</div>}
            {loading && <p className="account-loading">Loading your account data...</p>}

            {activeSection === 'overview' && (
              <>
                <div className="account-section-heading"><h2>Overview</h2><span>{profile.email}</span></div>
                {stats && (
                  <div className="account-stat-grid">
                    <AccountStat label="Total Orders" value={stats.totalOrders} />
                    <AccountStat label="Items Ordered" value={stats.totalItemsOrdered} />
                    <AccountStat label="Total Spent" value={`₹${stats.totalSpent.toLocaleString('en-IN')}`} />
                    <AccountStat label="Custom Orders" value={stats.customOrderCount} />
                  </div>
                )}
                <section className="account-panel">
                  <div className="account-panel-heading"><h3>Recent Orders</h3><Link to="/account/orders">View all</Link></div>
                  {orderRows.length ? orderRows.slice(0, 4).map((order) => (
                    <AccountOrderRow key={order.id} order={order} dateFor={dateFor} itemCountFor={itemCountFor} />
                  )) : <p className="account-empty">No orders yet.</p>}
                </section>
              </>
            )}

            {activeSection === 'orders' && (
              <>
                <div className="account-section-heading"><h2>My Orders</h2><span>{orderRows.length} order{orderRows.length === 1 ? '' : 's'}</span></div>
                {orderRows.length ? <div className="account-order-list">{orderRows.map((order) => (
                  <article className="account-order-card" key={order.id}>
                    <div className="account-order-top"><strong>Order #{order.id}</strong><span className="status-pill">{order.orderStatus}</span></div>
                    {order.orderType === 'PROMO_CODE' && <div className="order-row"><span>Purchase Type</span><strong><span className={`promo-purchase-badge ${order.purchaseType || 'online'}`}>{order.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</span></strong></div>}
                    {order.orderType === 'PROMO_CODE' && <PromoOrderAccountDetails order={order} />}
                    <div className="account-order-summary"><strong>{itemCountFor(order)} Items</strong><strong>₹{order.total}</strong></div>
                    <p>Placed: {dateFor(order.date)}</p>
                    {order.orderType === 'PROMO_CODE' && order.promoCode && <div className="order-row"><span>Promo Code</span><strong>{order.promoCode}</strong></div>}
                    {order.orderType === 'PROMO_CODE' && order.promoCodeStatus && <div className="order-row"><span>Redemption</span><strong>{order.promoCodeStatus === 'REDEEMED' ? 'Redeemed' : 'Ready to redeem'}</strong></div>}
                    {order.orderType === 'PROMO_CODE' && order.purchaseType === 'offline' && order.orderStatus === 'Pending Admin Approval' && <div className="order-row"><span>Fulfillment</span><strong>Pending admin approval</strong></div>}
                    <div className="account-order-items">{(order.items || []).map((item) => <span key={item.id}>{item.name} × {item.quantity}</span>)}</div>
                    {['Declined', 'Rejected'].includes(order.orderStatus) && order.refundCase && <><div className="order-row"><span>Refund Status</span><strong>{refundStatusLabel(order.refundCase.status)}</strong></div><div className="order-row"><span>Refund Amount</span><strong>₹{((order.refundCase.approvedRefundAmountPaise ?? order.refundCase.refundAmountPaise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></>}
                    <div className="account-order-top"><span>Payment: {order.paymentStatus}</span><div className="order-actions"><Link className="secondary-btn small" to="/order-placed" state={{ order }}>View Order</Link>{order.refundEligible && !order.cancelEligible && <Link className="secondary-btn small" to={`/refund/${encodeURIComponent(order.id)}`}>Refund</Link>}{order.cancelEligible && !order.refundEligible && <button className="secondary-btn small" onClick={() => onCancelOrder(order)}>Cancel</button>}</div></div>
                    {(order.cancellationId || order.orderStatus === 'Cancelled' || order.refundCase) && <div className="order-status-stamps">{(order.cancellationId || order.orderStatus === 'Cancelled') && <span className="order-cancelled-stamp">CANCELLED</span>}{order.refundCase && <span className="refund-order-stamp">{refundStatusLabel(order.refundCase.status).toUpperCase()}</span>}</div>}
                  </article>
                ))}</div> : <AccountEmpty text="No orders yet." />}
              </>
            )}

            {activeSection === 'history' && (
              <>
                <div className="account-section-heading"><h2>Order History</h2><span>All purchases</span></div>
                {orderRows.length ? (
                  <div className="account-table-wrap">
                    <table className="account-table">
                      <thead><tr><th>Order</th><th>Date</th><th>Products</th><th>Subtotal</th><th>Delivery</th><th>Total</th><th>Status</th><th /></tr></thead>
                      <tbody>{orderRows.map((order) => (
                        <tr key={order.id}>
                          <td>#{order.id}</td><td>{dateFor(order.date)}</td>
                          <td>{(order.items || []).map((item) => `${item.name} × ${item.quantity}`).join(', ')}</td>
                          <td>₹{order.subtotal}</td><td>{order.deliveryCharge ? `₹${order.deliveryCharge}` : 'FREE'}</td>
                          <td>₹{order.total}</td><td>{order.orderStatus}</td>
                          <td><Link to="/order-placed" state={{ order }}>Open</Link></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : <AccountEmpty text="No order history yet." />}
              </>
            )}

            {activeSection === 'items' && (
              <>
                <div className="account-section-heading"><h2>Total Items Ordered</h2><span>Across your order history</span></div>
                {stats && <>
                  <div className="items-total-banner"><span>Total individual items</span><strong>{stats.totalItemsOrdered}</strong></div>
                  <div className="account-stat-grid compact-stats">
                    <AccountStat label="Total Orders" value={stats.totalOrders} />
                    <AccountStat label="Total Items" value={stats.totalItemsOrdered} />
                    <AccountStat label="Total Amount Spent" value={`₹${stats.totalSpent.toLocaleString('en-IN')}`} />
                  </div>
                </>}
                {orderRows.length ? <div className="account-table-wrap"><table className="account-table">
                  <thead><tr><th>Date</th><th>Items</th><th>Order Total</th></tr></thead>
                  <tbody>{orderRows.map((order) => <tr key={order.id}><td>{dateFor(order.date)}</td><td>{itemCountFor(order)}</td><td>₹{order.total}</td></tr>)}</tbody>
                </table></div> : <AccountEmpty text="No ordered items yet." />}
              </>
            )}

            {activeSection === 'custom-orders' && (
              <>
                <div className="account-section-heading"><h2>Custom Orders</h2><Link className="primary-btn small" to="/custom-order">Request a part</Link></div>
                {currentCustomOrders.length ? <div className="account-order-list">{currentCustomOrders.map((order) => (
                  <article className="account-order-card" key={order._id}>
                    <div className="account-order-top"><strong>{order.requestedItem}</strong><span className={`status-pill status-${order.status.toLowerCase()}`}>{order.status}</span></div>
                    <p>Requested: {dateFor(order.createdAt)}</p>
                    {order.status === 'Ordered' && <p>Order status: Ordered</p>}
                    {order.status === 'Accepted' && <button className="primary-btn small" onClick={() => onOrderCustomItem(order)}>Order This Item</button>}
                  </article>
                ))}</div> : <AccountEmpty text="No custom order requests yet." />}
              </>
            )}

            {activeSection === 'wallet' && (
              <section className="account-panel wallet-account-card">
                <span className="eyebrow">Secure balance</span>
                <h2>My Wallet</h2>
                <p>Recharge and manage wallet payments securely.</p>
                <Link className="primary-btn" to="/wallet">Open Wallet</Link>
              </section>
            )}

            {activeSection === 'wishlist' && <WishlistAccountSection
              wishlist={wishlist}
              onAddToCart={onAddToCart}
              onAddPromoToCart={onAddWishlistPromoToCart}
              onRemove={onRemoveWishlistItem}
            />}

            {activeSection === 'reward-points' && <RewardPointsAccountSection />}
            {activeSection === 'discount-codes' && <CustomerDiscountCodesSection />}
            {activeSection === 'scratch-cards' && <CustomerScratchCardsSection />}
            {activeSection === 'invoices' && <CustomerInvoicesSection />}

            {activeSection === 'plan' && <AccountPlanSection />}

            {activeSection === 'ai-credits' && <AICreditSection />}

            {activeSection === 'address' && (
              <>
                <div className="account-section-heading"><h2>Saved Address</h2><span>Used for checkout autofill</span></div>
                {editingAddress ? (
                  <form className="account-form address-grid" onSubmit={(event) => { event.preventDefault(); onSaveAddress(addressDraft); setEditingAddress(false); }}>
                    {[
                      ['fullName', 'Name'], ['phoneNumber', 'Phone'], ['addressLine1', 'Address'],
                      ['addressLine2', 'Address line 2'], ['city', 'City'], ['state', 'State'], ['pinCode', 'PIN Code'], ['country', 'Country'],
                    ].map(([field, label]) => <label key={field}>{label}<input required={field !== 'addressLine2'} value={addressDraft[field] || ''} onChange={(event) => setAddressDraft((current) => ({ ...current, [field]: event.target.value }))} /></label>)}
                    <div className="account-form-actions full-width"><button type="button" className="secondary-btn" onClick={() => setEditingAddress(false)}>Cancel</button><button className="primary-btn">Save Address</button></div>
                  </form>
                ) : address?.fullName ? (
                  <article className="account-panel address-panel">
                    <span className="eyebrow">Delivery address</span>
                    <h3>{address.fullName}</h3>
                    <p>{address.phoneNumber}</p><p>{addressLine}</p><p>{[address.city, address.state, address.pinCode].filter(Boolean).join(', ')}</p><p>{address.country}</p>
                    <button className="secondary-btn small" onClick={() => setEditingAddress(true)}>Edit Address</button>
                  </article>
                ) : <div className="account-panel"><p className="account-empty">No saved delivery address yet.</p><button className="secondary-btn small" onClick={() => setEditingAddress(true)}>Add Address</button></div>}
              </>
            )}

            {activeSection === 'notifications' && (
              <>
                <div className="account-section-heading"><h2>Notifications</h2><span>{notifications.filter((item) => !item.read).length} unread</span></div>
                {notifications.length ? <div className="notification-account-list">{notifications.map((notification) => (
                  <article className={`account-notification ${notification.read ? 'read' : 'unread'}`} key={notification._id}>
                    <div><span className="notification-check" aria-hidden="true">✓</span><strong>{notification.message}</strong></div>
                    <time>{dateFor(notification.createdAt)}</time>
                    {notification.type === 'scratch_card_awarded' && <Link className="primary-btn small" to="/account/scratch-cards">Scratch Now</Link>}
                    {!notification.read && <button className="secondary-btn small" onClick={() => onMarkRead(notification)}>Mark as read</button>}
                  </article>
                ))}</div> : <AccountEmpty text="No new notifications." />}
              </>
            )}

            {activeSection === 'settings' && (
              <>
                <div className="account-section-heading"><h2>Account Settings</h2><span>Profile details</span></div>
                <form className="account-form settings-form" onSubmit={savePhone}>
                  <label>Name<input value={profile.name || ''} readOnly /></label>
                  <label>Email<input value={profile.email || ''} readOnly /></label>
                  <label>Phone<input type="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="Add a phone number" maxLength={30} /></label>
                  <p className="account-hint">Name and email are managed by your Google account.</p>
                  {(settingsError || notice) && <p className={settingsError ? 'voice-error' : 'account-notice'}>{settingsError || notice}</p>}
                  <button className="primary-btn" disabled={savingSettings}>{savingSettings ? 'Saving...' : 'Save Phone Number'}</button>
                </form>
              </>
            )}

            {activeSection === 'sign-out' && (
              <section className="signout-panel">
                <span className="eyebrow">Sign out</span>
                <h2>We're sorry to see you go.</h2>
                <p>Are you sure you want to sign out from Innovation Labs?</p>
                <div className="account-form-actions">
                  <Link className="secondary-btn" to="/account/overview">Cancel</Link>
                  <button className="primary-btn signout-button" onClick={onSignOut}>Sign Out</button>
                </div>
              </section>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function WishlistAccountSection({ wishlist, onAddToCart, onAddPromoToCart, onRemove }) {
  const imageFor = (item) => item.image
    || (item.productType === 'promo' || item.productType === 'discount-code'
      ? productImages.display
      : historyProductImage(item));
  return <section className="wishlist-account-section">
    <div className="account-section-heading"><h2>My Wishlist</h2><span>{wishlist.length} saved item{wishlist.length === 1 ? '' : 's'}</span></div>
    {wishlist.length ? <div className="wishlist-product-grid">{wishlist.map((item) => {
      const unavailable = ['Unavailable', 'Out of Stock'].includes(item.availability) || item.stock === 0;
      const product = {
        id: item.productType === 'discount-code' ? `discount-${item.productId}` : item.productId,
        discountOfferId: item.productType === 'discount-code' ? item.productId : undefined,
        name: item.name,
        category: item.category,
        price: Number(item.price) || 0,
        image: imageFor(item),
        inventoryProduct: Boolean(item.inventoryProduct),
        stock: item.stock,
        availableQuantity: item.productType === 'discount-code' ? item.stock : undefined,
        status: item.availability,
      };
      return <article className="wishlist-product-card" key={`${item.productType}:${item.productId}`}>
        <div className="wishlist-product-image"><img src={imageFor(item)} alt={item.name} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = fallbackProductImage; }} /></div>
        <div className="wishlist-product-details"><span className="wishlist-product-category">{item.category}</span><h3>{item.name}</h3><div className="wishlist-product-meta"><strong>₹{Number(item.price || 0).toLocaleString('en-IN')}</strong><span className={unavailable ? 'wishlist-unavailable' : 'wishlist-available'}>{unavailable ? 'Unavailable' : item.availability || 'In Stock'}</span></div>
          <div className="wishlist-product-actions"><button className="primary-btn small" disabled={unavailable} onClick={() => item.productType === 'promo' ? onAddPromoToCart(item) : onAddToCart(product)}>Add to Cart</button><button className="secondary-btn small" onClick={() => onRemove(item.productType, item.productId)}>Remove</button></div>
        </div>
      </article>;
    })}</div> : <div className="wishlist-empty-state"><span className="wishlist-empty-mark" aria-hidden="true">♡</span><h3>Your wishlist is ready for ideas.</h3><p>Save promo codes and components here to find them again later.</p><Link className="primary-btn" to="/products">Explore Products</Link></div>}
  </section>;
}

function CustomerDiscountCodesSection() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    requestApi('/api/discount-codes/mine').then((result) => { if (active) setCodes(result.discountCodes || []); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const copy = async (code) => { try { await navigator.clipboard.writeText(code); } catch { setError('Select and copy the code manually.'); } };
  return <section className="account-panel customer-discount-codes"><div className="account-section-heading"><h2>Discount Promo Codes</h2><Link className="primary-btn small" to="/discount-codes">Browse Offers</Link></div>{error && <div className="alert-box">{error}</div>}{loading ? <p className="account-loading">Loading your discount codes...</p> : codes.length ? <div className="customer-discount-code-list">{codes.map((item) => <article key={item.purchaseId}><div><strong>{item.isScratchReward ? 'Scratch Card Reward' : item.discountLabel}</strong><small>Order #{item.orderId} · Expires {new Date(item.expiresAt).toLocaleDateString('en-IN')}</small></div><code>{item.code}</code><span className={`status-pill ${item.status === 'available' ? '' : 'status-rejected'}`}>{item.status}</span><button className="secondary-btn small" onClick={() => copy(item.code)}>Copy</button></article>)}</div> : <AccountEmpty text="Your fulfilled Discount Promo Codes will appear here." />}</section>;
}

function ScratchSurface({ scratchCard, onReveal }) {
  const canvasRef = useRef(null);
  const scratched = useRef(false);
  const drawing = useRef(false);
  const sampleCount = useRef(0);
  const revealed = scratchCard.status !== 'issued';
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || revealed) return;
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    const gradient = context.createLinearGradient(0, 0, rect.width, rect.height);
    gradient.addColorStop(0, '#9baeb2'); gradient.addColorStop(0.48, '#d7e0de'); gradient.addColorStop(1, '#728a91');
    context.fillStyle = gradient; context.fillRect(0, 0, rect.width, rect.height);
    context.fillStyle = 'rgba(10, 31, 39, 0.75)'; context.font = '700 15px sans-serif'; context.textAlign = 'center'; context.fillText('SCRATCH TO REVEAL', rect.width / 2, rect.height / 2);
    context.globalCompositeOperation = 'destination-out';
    return () => { scratched.current = false; drawing.current = false; };
  }, [revealed, scratchCard.scratchCardId]);
  const scratchAt = (event) => {
    const canvas = canvasRef.current;
    if (!canvas || revealed || !drawing.current) return;
    const rect = canvas.getBoundingClientRect();
    const context = canvas.getContext('2d');
    context.globalCompositeOperation = 'destination-out';
    context.beginPath(); context.arc(event.clientX - rect.left, event.clientY - rect.top, 19, 0, Math.PI * 2); context.fill();
    sampleCount.current += 1;
    if (sampleCount.current % 8 === 0 && !scratched.current) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0;
      for (let index = 3; index < pixels.length; index += 32) if (pixels[index] < 16) transparent += 1;
      if (transparent / (pixels.length / 32) >= 0.38) {
        scratched.current = true;
        onReveal(scratchCard.scratchCardId);
      }
    }
  };
  return <canvas ref={canvasRef} className={`scratch-surface ${revealed ? 'is-revealed' : ''}`} aria-label="Scratch this card to reveal its reward" onPointerDown={(event) => { if (revealed) return; drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); scratchAt(event); }} onPointerMove={scratchAt} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />;
}

function CustomerScratchCardsSection() {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    requestApi('/api/scratch-cards').then((result) => { if (active) setCards(result.scratchCards || []); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const reveal = async (scratchCardId) => {
    try {
      const result = await requestApi(`/api/scratch-cards/${encodeURIComponent(scratchCardId)}/reveal`, { method: 'POST' });
      setCards((current) => current.map((card) => card.scratchCardId === scratchCardId ? { ...card, ...result.scratchCard } : card));
    } catch (requestError) { setError(requestError.message); }
  };
  const copy = async (code) => { try { await navigator.clipboard.writeText(code); } catch { setError('Select and copy the code manually.'); } };
  return <section className="account-panel scratch-cards-section"><div className="account-section-heading"><h2>My Scratch Cards</h2><span>{cards.length} card{cards.length === 1 ? '' : 's'}</span></div>{error && <div className="alert-box">{error}</div>}{loading ? <p className="account-loading">Loading scratch cards...</p> : cards.length ? <div className="scratch-card-grid">{cards.map((card) => <article className="scratch-card" key={card.scratchCardId}><div className="scratch-card-top"><span>INNOVATION LABS · REWARD</span><span>ORDER #{card.orderId}</span></div><div className="scratch-reward-underlay"><strong>{card.status === 'issued' ? 'A reward awaits' : 'CONGRATULATIONS!'}</strong><span>{card.status === 'issued' ? 'Scratch the surface to reveal your code.' : `You unlocked ${card.rewardType === 'percentage' ? `${card.rewardValue}% off` : `₹${card.rewardValue} off`}`}</span>{card.code && <code>{card.code}</code>}</div>{card.status === 'issued' ? <ScratchSurface scratchCard={card} onReveal={reveal} /> : card.code && <button className="secondary-btn small" onClick={() => copy(card.code)}>Copy Code</button>}<small>Eligible order value ₹{Number(card.eligibleOrderAmount).toLocaleString('en-IN')} · {new Date(card.createdAt).toLocaleDateString('en-IN')}</small></article>)}</div> : <AccountEmpty text="Eligible purchases above the current threshold unlock scratch cards here." />}</section>;
}

function CustomerInvoicesSection() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');
  useEffect(() => {
    let active = true;
    requestApi('/api/invoices').then((result) => { if (active) setInvoices(result.invoices || []); })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const download = async (invoice) => {
    setDownloading(invoice.invoiceId);
    setError('');
    try {
      await downloadInvoicePdf(`/api/invoices/${encodeURIComponent(invoice.invoiceId)}/download`, invoice.invoiceNumber);
    } catch (requestError) { setError(requestError.message); }
    finally { setDownloading(''); }
  };
  return <section className="account-panel invoice-account-section"><div className="account-section-heading"><h2>My Invoices</h2><span>{invoices.length} invoices</span></div>{error && <div className="alert-box">{error}</div>}{loading ? <p className="account-loading">Loading invoices...</p> : invoices.length ? <div className="invoice-list">{invoices.map((invoice) => <article key={invoice.invoiceId}><div><strong>{invoice.invoiceNumber}</strong><small>Order #{invoice.orderId} · {new Date(invoice.createdAt).toLocaleDateString('en-IN')}</small></div><strong>₹{(invoice.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong><span className="status-pill">{invoice.paymentStatus}</span><button className="secondary-btn small" disabled={downloading === invoice.invoiceId} onClick={() => download(invoice)}>{downloading === invoice.invoiceId ? 'Preparing...' : 'Download PDF'}</button></article>)}</div> : <AccountEmpty text="Invoices from successful purchases will appear here." />}</section>;
}

function RewardPointsAccountSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionType, setConversionType] = useState('wallet');
  const [pointsToConvert, setPointsToConvert] = useState('100');
  const [converting, setConverting] = useState(false);
  const account = data?.account || { availablePoints: 0, lifetimePointsEarned: 0, lifetimePointsRedeemed: 0 };
  const transactions = data?.transactions || [];
  const maximumConversion = Math.floor(account.availablePoints / 100) * 100;
  const reload = async () => {
    const result = await requestApi('/api/rewards');
    setData(result);
  };

  useEffect(() => {
    let active = true;
    requestApi('/api/rewards').then((result) => {
      if (active) setData(result);
    }).catch((requestError) => {
      if (active) setError(requestError.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const openConversion = (type = 'wallet') => {
    setNotice('');
    if (account.availablePoints < 100) {
      setNotice('At least 100 available reward points are required for a conversion.');
      return;
    }
    setConversionType(type);
    setPointsToConvert(String(maximumConversion));
    setConversionOpen(true);
  };

  const confirmConversion = async (event) => {
    event.preventDefault();
    const points = Number(pointsToConvert);
    if (!Number.isSafeInteger(points) || points < 100 || points % 100 !== 0 || points > maximumConversion) {
      setError('Choose a conversion amount in multiples of 100 points within your available balance.');
      return;
    }
    setConverting(true);
    setError('');
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() || `reward-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await requestApi('/api/rewards/convert', {
        method: 'POST',
        body: JSON.stringify({ pointsToConvert: points, idempotencyKey, conversionType }),
      });
      setData((current) => ({ ...(current || {}), account: result.account, transactions: [result.transaction, ...(current?.transactions || [])] }));
      setNotice(conversionType === 'discount-code'
        ? `${points} points were converted to a ₹${points.toLocaleString('en-IN')} Discount Promo Code Scratch Card. Scratch it to reveal your code.`
        : `${points} points were converted to ₹${points.toLocaleString('en-IN')} in your Wallet.`);
      setConversionOpen(false);
    } catch (requestError) {
      setError(requestError.message);
      try { await reload(); } catch { }
    } finally {
      setConverting(false);
    }
  };

  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - 5 + index);
    const points = transactions.filter((transaction) => {
      const createdAt = new Date(transaction.createdAt);
      return transaction.transactionType === 'earned' && createdAt.getFullYear() === date.getFullYear() && createdAt.getMonth() === date.getMonth();
    }).reduce((sum, transaction) => sum + transaction.points, 0);
    return { label: date.toLocaleDateString('en-IN', { month: 'short' }), points };
  });
  const chartMaximum = Math.max(1, ...months.map((month) => month.points));

  if (loading) return <div className="account-loading">Loading reward points...</div>;
  return <section className="reward-account-section">
    <div className="account-section-heading"><h2>Reward Points</h2><span>Earn on eligible purchases</span></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    <div className="reward-summary-grid"><article className="reward-balance-card"><span>Available points</span><strong>{account.availablePoints.toLocaleString('en-IN')}</strong><small>100 points = ₹100 value</small><div className="reward-conversion-actions"><button className="primary-btn small" onClick={() => openConversion('wallet')}>Send to Wallet</button><button className="secondary-btn small" onClick={() => openConversion('discount-code')}>Convert Points to Promo Code</button></div></article><article className="reward-stat-card"><span>Lifetime points earned</span><strong>{account.lifetimePointsEarned.toLocaleString('en-IN')}</strong></article><article className="reward-stat-card"><span>Converted to Wallet</span><strong>{account.lifetimePointsRedeemed.toLocaleString('en-IN')}</strong><small>Includes points redeemed for wallet credit or promo code rewards</small></article></div>
    <section className="account-panel reward-chart-panel"><div className="account-panel-heading"><h3>Points earned over time</h3><span>Last 6 months</span></div><div className="reward-chart" role="img" aria-label="Reward points earned by month">{months.map((month) => <div className="reward-chart-column" key={`${month.label}-${month.points}`}><strong>{month.points || ''}</strong><div className="reward-chart-track"><span style={{ height: `${Math.max(4, month.points / chartMaximum * 100)}%` }} /></div><small>{month.label}</small></div>)}</div></section>
    <section className="account-panel reward-history-panel"><div className="account-panel-heading"><h3>Reward History</h3><span>{transactions.length} transactions</span></div>{transactions.length ? <div className="reward-history-list">{transactions.map((transaction) => <article className="reward-history-row" key={transaction.transactionId}><div><strong>{transaction.orderId ? `Order #${transaction.orderId}` : transaction.transactionType === 'redeemed' ? 'Wallet conversion' : 'Reward adjustment'}</strong><small>{new Date(transaction.createdAt).toLocaleDateString('en-IN')} · {transaction.productType || 'Purchase'}</small></div><div><span>{transaction.transactionType === 'redeemed' ? 'Wallet amount' : 'Eligible amount'}</span><strong>₹{((transaction.transactionType === 'redeemed' ? Number(transaction.walletAmountPaise || 0) : Number(transaction.eligibleAmountPaise || 0)) / 100).toLocaleString('en-IN')}</strong></div><div><span>Points</span><strong className={`reward-points-${transaction.transactionType}`}>{transaction.transactionType === 'reversed' ? '−' : transaction.transactionType === 'redeemed' ? '−' : '+'}{transaction.points}</strong></div><span className={`reward-status reward-status-${transaction.status}`}>{transaction.status}</span></article>)}</div> : <p className="account-empty">Points from eligible paid orders will appear here.</p>}</section>
    {conversionOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal reward-conversion-modal" role="dialog" aria-modal="true" aria-labelledby="reward-conversion-title" onSubmit={confirmConversion}><h2 id="reward-conversion-title">{conversionType === 'discount-code' ? 'Convert Points to Promo Code' : 'Send points to Wallet'}</h2><p>{conversionType === 'discount-code' ? 'Your points will be converted to a discount promo code scratch card. The code stays hidden until you scratch it.' : 'Convert points in multiples of 100. Your points and Wallet balance update together.'}</p><label>Points to convert<input type="number" min="100" max={maximumConversion} step="100" value={pointsToConvert} onChange={(event) => setPointsToConvert(event.target.value)} required /></label><div className="reward-conversion-preview"><span>{conversionType === 'discount-code' ? 'Discount code reward' : 'Wallet credit'}</span><strong>₹{(Number(pointsToConvert) || 0).toLocaleString('en-IN')}</strong></div>{error && <div className="alert-box" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-btn" disabled={converting} onClick={() => setConversionOpen(false)}>Cancel</button><button className="primary-btn" disabled={converting || Number(pointsToConvert) < 100 || Number(pointsToConvert) > maximumConversion || Number(pointsToConvert) % 100 !== 0}>{converting ? 'Converting...' : 'Confirm Conversion'}</button></div></form></div>}
  </section>;
}

function AccountStat({ label, value }) {
  return <article className="account-stat"><span>{label}</span><strong>{value}</strong></article>;
}

function AccountEmpty({ text }) {
  return <div className="account-empty-state"><p>{text}</p></div>;
}

function PinBoxes({ value, onChange, autoFocus = true, disabled = false }) {
  const refs = useRef([]);
  const digits = `${value || ''}`.slice(0, 4).split('');
  while (digits.length < 4) digits.push('');
  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);
  const setDigit = (index, digit) => {
    const next = digits.map((item, position) => position === index ? digit.replace(/\D/g, '').slice(-1) : item).join('');
    onChange(next);
    if (digit && index < 3) refs.current[index + 1]?.focus();
  };
  return <div className="pin-boxes">{digits.map((digit, index) => (
    <input
      key={index}
      ref={(element) => { refs.current[index] = element; }}
      value={digit}
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={1}
      disabled={disabled}
      autoFocus={autoFocus && index === 0}
      autoComplete="off"
      aria-label={`PIN digit ${index + 1}`}
      onChange={(event) => setDigit(index, event.target.value)}
      onPaste={(event) => {
        const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
        if (!pasted) return;
        event.preventDefault();
        onChange(pasted);
        refs.current[Math.min(pasted.length, 3)]?.focus();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Backspace' && !digits[index] && index > 0) refs.current[index - 1]?.focus();
        if (event.key === 'ArrowLeft' && index > 0) refs.current[index - 1]?.focus();
        if (event.key === 'ArrowRight' && index < 3) refs.current[index + 1]?.focus();
      }}
    />
  ))}</div>;
}

function WalletPage({ auth, accessVersion, onRequestUnlock }) {
  const location = useLocation();
  const [wallet, setWallet] = useState(null);
  const [promoCodes, setPromoCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('500');
  const [activeTab, setActiveTab] = useState(() => location.state?.openPromoTab ? 'promo' : 'wallet');
  const [activeSection, setActiveSection] = useState('overview');
  const [transferIntroOpen, setTransferIntroOpen] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!auth) return;
    let active = true;
    setWallet(null);
    setLoading(true);
    setMessage('');
    requestApi('/api/wallet').then((result) => {
      if (!active) return;
      if (result.setupRequired) {
        onRequestUnlock();
        return;
      }
      setWallet(result.wallet);
    }).catch((error) => {
      if (!active) return;
      if (error.status === 423) {
        onRequestUnlock();
        return;
      }
      setMessage(error.message || 'Unable to load your wallet right now. Please try again.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [auth, accessVersion]);

  useEffect(() => {
    if (!auth || activeTab !== 'promo') return undefined;
    let active = true;
    requestApi('/api/wallet/promo-codes').then((result) => {
      if (active) setPromoCodes(result.promoCodes || []);
    }).catch((error) => {
      if (active && error.status !== 423) setMessage(error.message || 'Unable to load your Promo Codes.');
    });
    return () => { active = false; };
  }, [auth, activeTab, accessVersion]);

  if (!auth) return <SignInRequiredPage onSignIn={() => { window.location.href = '/'; }} />;

  const recharge = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 10) {
      setMessage('Minimum wallet recharge is ₹10.');
      return;
    }
    if (!window.Razorpay) { setMessage('Online payment is unavailable. Please try again.'); return; }
    try {
      const paymentOrder = await requestApi('/api/wallet/recharge/order', { method: 'POST', body: JSON.stringify({ amountPaise: Math.round(value * 100) }) });
      const razorpay = new window.Razorpay({
        key: paymentOrder.keyId,
        order_id: paymentOrder.orderId,
        amount: paymentOrder.amountPaise,
        currency: 'INR', name: 'Innovation Labs', description: 'Wallet Recharge',
        handler: async (response) => {
          try {
            const result = await requestApi('/api/wallet/recharge/verify', { method: 'POST', body: JSON.stringify({ ...response, amountPaise: paymentOrder.amountPaise }) });
            setWallet(result.wallet);
            setMessage(`₹${value.toLocaleString('en-IN')} has been added to your wallet.`);
          } catch (requestError) { setMessage(requestError.message); }
        },
      });
      razorpay.open();
    } catch (requestError) { setMessage(requestError.message); }
  };

  if (!wallet) return <main className="page-shell"><div className="container loader-wrap">{loading && <div className="spinner" />}<p>{message || 'Verifying wallet access...'}</p></div></main>;

  return <main className="page-shell"><div className="container wallet-shell">
    <div className="wallet-workspace">
      <aside className="wallet-sidebar" aria-label="Wallet navigation">
        <span className="wallet-sidebar-title">Wallet</span>
        <nav>
          <button className={activeSection === 'overview' ? 'active' : ''} aria-current={activeSection === 'overview' ? 'page' : undefined} onClick={() => setActiveSection('overview')}>Wallet Overview</button>
          <button className={activeSection === 'transfer' ? 'active' : ''} aria-current={activeSection === 'transfer' ? 'page' : undefined} onClick={() => setTransferIntroOpen(true)}>Transfer Money</button>
        </nav>
      </aside>
      <div className="wallet-workspace-content">
        {activeSection === 'overview' ? <>
          <div className="wallet-header"><span className="eyebrow">Secure payments</span><h1>My Wallet</h1><p>Use your Innovation Labs balance for faster checkout.</p></div>
          <div className="wallet-balance-card"><span>Available Balance</span><strong>₹{wallet.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong><button className="primary-btn small" onClick={() => setActiveTab('recharge')}>Recharge Wallet</button></div>
          <div className="wallet-tabs" role="tablist" aria-label="Wallet overview sections"><button role="tab" aria-selected={activeTab === 'wallet'} className={activeTab === 'wallet' ? 'active' : ''} onClick={() => setActiveTab('wallet')}>Wallet</button><button role="tab" aria-selected={activeTab === 'history'} className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>History</button><button role="tab" aria-selected={activeTab === 'recharge'} className={activeTab === 'recharge' ? 'active' : ''} onClick={() => setActiveTab('recharge')}>Recharge</button><button role="tab" aria-selected={activeTab === 'promo'} className={activeTab === 'promo' ? 'active' : ''} onClick={() => setActiveTab('promo')}>Promo Code</button></div>
          {message && <div className="account-notice">{message}</div>}
          {activeTab === 'recharge' && <section className="wallet-panel"><h2>Recharge Wallet</h2><div className="recharge-options">{[500, 1000, 2000].map((value) => <button key={value} className="secondary-btn" onClick={() => setAmount(String(value))}>₹{value.toLocaleString('en-IN')}</button>)}</div><label className="wallet-amount">Custom Recharge<input type="number" min="10" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" /></label><button className="primary-btn" onClick={recharge}>Pay ₹{Number(amount || 0).toLocaleString('en-IN')}</button></section>}
          {activeTab === 'wallet' && <section className="wallet-panel"><h2>Wallet payments</h2><p>Choose Wallet at checkout to pay securely from this balance. Your PIN is required for every wallet payment.</p></section>}
          {activeTab === 'history' && <section className="wallet-panel"><h2>Wallet History</h2>{wallet.transactions.length ? <div className="wallet-history">{wallet.transactions.map((transaction) => <article key={transaction.id}><span className={`wallet-amount-sign ${transaction.amount >= 0 ? 'positive' : 'negative'}`}>{transaction.amount >= 0 ? '+' : '-'}₹{Math.abs(transaction.amount).toLocaleString('en-IN')}</span><div><strong>{transaction.type}</strong><p>{transaction.description}</p><small>{new Date(transaction.createdAt).toLocaleString()} · {transaction.status}</small></div></article>)}</div> : <AccountEmpty text="No wallet transactions yet." />}</section>}
          {activeTab === 'promo' && <PromoWalletPanel promoCodes={promoCodes} onRedeemed={(result) => {
            setWallet((current) => ({ ...current, balance: result.balance, transactions: [result.transaction, ...current.transactions] }));
            setPromoCodes((current) => current.map((promo) => promo.code === result.transaction.description?.replace('Promo Code: ', '') ? { ...promo, successfulUses: result.successfulUses, remainingUses: result.remainingUses, status: result.fullyRedeemed ? 'fully_redeemed' : 'purchased' } : promo));
            setMessage(`₹${result.amount.toLocaleString('en-IN')} added to your wallet.`);
          }} />}
        </> : <WalletTransferWorkspace wallet={wallet} onWalletUpdate={setWallet} onBackToOverview={() => setActiveSection('overview')} />}
      </div>
    </div>
    {transferIntroOpen && <div className="wallet-lock-overlay"><section className="wallet-pin-modal transfer-intro-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-intro-title"><h2 id="transfer-intro-title">Transfer Money</h2><p>Securely transfer money from your Innovation Labs Wallet to another user’s wallet using their Wallet ID.</p><p>You will need the recipient’s Wallet ID to continue.</p><div className="modal-actions"><button className="secondary-btn" onClick={() => setTransferIntroOpen(false)}>Cancel</button><button className="primary-btn" onClick={() => { setTransferIntroOpen(false); setActiveSection('transfer'); }}>Continue</button></div></section></div>}
  </div></main>;
}

function PromoWalletPanel({ promoCodes, onRedeemed }) {
  const [code, setCode] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const redeem = async () => {
    setBusy(true);
    try {
      const result = await requestApi('/api/wallet/promo/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      onRedeemed(result);
      setCode('');
      setConfirmationOpen(false);
      setFeedback({ title: result.fullyRedeemed ? 'Promo Code Fully Redeemed' : 'Promo Code Use Confirmed', message: `₹${result.amount.toLocaleString('en-IN')} added to your wallet. New balance: ₹${result.balance.toLocaleString('en-IN')}. ${result.remainingUses} successful uses remain.`, success: true });
    } catch (error) {
      setConfirmationOpen(false);
      setFeedback({ title: error.code === 'PROMO_EXPIRED' ? 'Promo Code Expired' : error.message.includes('maximum successful redemptions') || error.message.includes('already been redeemed') ? 'Promo Code Fully Redeemed' : error.message.includes('invalid or does not exist') ? 'Invalid Promo Code' : 'Promo Code Could Not Be Redeemed', message: error.message, success: false });
    } finally {
      setBusy(false);
    }
  };

  return <section className="wallet-panel"><h2>My Promo Codes</h2>{promoCodes?.length ? <div className="wallet-promo-code-list">{promoCodes.map((promo) => <WalletPromoCode key={promo.id} promo={promo} />)}</div> : <p>No active or past Promo Codes are assigned to your account.</p>}<h3>Redeem a Promo Code</h3><p>Redeem a code to add its value to your wallet balance.</p><label className="wallet-amount">Enter Promo Code<input value={code} onChange={(event) => setCode(formatPromoCode(event.target.value))} placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={19} autoCapitalize="characters" /></label><button className="primary-btn" disabled={!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)} onClick={() => setConfirmationOpen(true)}>OK</button>
    {confirmationOpen && <div className="wallet-lock-overlay"><div className="wallet-pin-modal promo-confirm-modal"><h2>Checking Promo Code</h2><p>Your promo code will be checked first. If the promo code is valid, the corresponding amount will be added to your wallet.</p><div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setConfirmationOpen(false)}>Cancel</button><button className="primary-btn" disabled={busy} onClick={redeem}>{busy ? 'Checking...' : 'OK'}</button></div></div></div>}
    {feedback && <div className="wallet-lock-overlay"><div className="wallet-pin-modal"><h2>{feedback.title}</h2><p>{feedback.message}</p><button className="primary-btn full" onClick={() => setFeedback(null)}>OK</button></div></div>}
  </section>;
}

function WalletPromoCode({ promo }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = promo.expiresAt ? Math.max(0, new Date(promo.expiresAt).getTime() - now) : null;
  const expiredByClock = remaining === 0 && promo.status === 'purchased';
  const status = expiredByClock ? 'expired' : promo.status;
  const seconds = remaining == null ? 0 : Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const statusLabel = status === 'fully_redeemed' || status === 'used' ? 'FULLY REDEEMED' : status === 'expired' ? 'EXPIRED' : 'ACTIVE';
  return <article className={`wallet-promo-code-card ${status}`}>
    <div className="wallet-promo-code-heading"><div><strong>Digital Wallet Credit</strong>{promo.gift && <span className="promo-recipient-badge gift">GIFT RECEIVED</span>}</div><span className={`promo-code-state ${status}`}>{statusLabel}</span></div>
    <code>{promo.code}</code>
    <dl><div><dt>Wallet Credit Value</dt><dd>₹{Number(promo.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Successful Uses</dt><dd>{promo.successfulUses} / {promo.maxUses} · {promo.remainingUses} remaining</dd></div>{promo.buyerName && <div><dt>Gift From</dt><dd>{promo.buyerName} · {promo.buyerEmail}</dd></div>}{promo.activatedAt && <div><dt>Activated</dt><dd>{new Date(promo.activatedAt).toLocaleString()}</dd></div>}{promo.expiresAt && <div><dt>Expires</dt><dd>{new Date(promo.expiresAt).toLocaleString()}</dd></div>}</dl>
    {status === 'purchased' && remaining != null && <strong className="promo-countdown">Time Remaining: {days} Days : {String(hours).padStart(2, '0')} Hours : {String(minutes).padStart(2, '0')} Minutes : {String(restSeconds).padStart(2, '0')} Seconds</strong>}
  </article>;
}

function WalletTransferWorkspace({ wallet, onWalletUpdate, onBackToOverview }) {
  const [view, setView] = useState('checking-id');
  const [walletId, setWalletId] = useState(wallet.walletId || '');
  const [walletIdSuffix, setWalletIdSuffix] = useState('');
  const [recipientSuffix, setRecipientSuffix] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [recipientConfirmOpen, setRecipientConfirmOpen] = useState(false);
  const [recipientBusy, setRecipientBusy] = useState(false);
  const [creatingId, setCreatingId] = useState(false);
  const [amount, setAmount] = useState('');
  const [amountPaise, setAmountPaise] = useState(0);
  const [balanceAtConfirmationPaise, setBalanceAtConfirmationPaise] = useState(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transfer, setTransfer] = useState(null);
  const transferKeyRef = useRef('');

  useEffect(() => {
    let active = true;
    requestApi('/api/wallet/transfers/account').then((result) => {
      if (!active) return;
      if (result.walletId) {
        setWalletId(result.walletId);
        setView('recipient');
      } else {
        setView('create-id');
      }
    }).catch((requestError) => {
      if (active) {
        setError(requestError.message);
        setView('error');
      }
    });
    return () => { active = false; };
  }, []);

  const suffixFromInput = (value) => {
    const raw = String(value || '').trim().toUpperCase().replace(/^@WL/, '').replace(/[^A-Z0-9]/g, '');
    return `${raw.replace(/[^A-Z]/g, '').slice(0, 4)}${raw.replace(/\D/g, '').slice(0, 4)}`;
  };
  const ownWalletId = walletId || wallet.walletId;
  const validRecipientSuffix = /^[A-Z]{4}\d{4}$/.test(recipientSuffix);
  const availablePaise = Math.round(Number(wallet.balance || 0) * 100);

  const createWalletId = async () => {
    if (!/^[A-Z]{4}\d{4}$/.test(walletIdSuffix) || creatingId) return;
    setCreatingId(true);
    setError('');
    try {
      const result = await requestApi('/api/wallet/transfers/wallet-id', { method: 'POST', body: JSON.stringify({ walletId: walletIdSuffix }) });
      setWalletId(result.walletId);
      onWalletUpdate((current) => ({ ...current, walletId: result.walletId }));
      setView('created-id');
    } catch (requestError) {
      if (requestError.status === 409) {
        try {
          const existing = await requestApi('/api/wallet/transfers/account');
          if (existing.walletId) {
            setWalletId(existing.walletId);
            onWalletUpdate((current) => ({ ...current, walletId: existing.walletId }));
            setView('recipient');
            return;
          }
        } catch { }
      }
      setError(requestError.message);
    } finally {
      setCreatingId(false);
    }
  };

  const checkRecipient = async (event) => {
    event.preventDefault();
    if (!validRecipientSuffix || recipientBusy) return;
    setRecipientBusy(true);
    setError('');
    setRecipient(null);
    setRecipientConfirmOpen(false);
    setRecipientSuffix((current) => current);
    transferKeyRef.current = '';
    try {
      const result = await requestApi('/api/wallet/transfers/recipient', {
        method: 'POST',
        body: JSON.stringify({ walletId: `@WL${recipientSuffix}` }),
      });
      setRecipient(result.recipient);
      setRecipientConfirmOpen(true);
    } catch (requestError) {
      setError(requestError.message || 'Wallet ID not found. Please check the Wallet ID and try again.');
    } finally {
      setRecipientBusy(false);
    }
  };

  const confirmRecipient = () => {
    setRecipientConfirmOpen(false);
    setAmount('');
    setAmountPaise(0);
    setError('');
    setView('amount');
  };

  const continueToConfirmation = async (event) => {
    event.preventDefault();
    if (checkingBalance) return;
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(amount)) {
      setError('Enter an amount using up to two decimal places.');
      return;
    }
    const paise = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(paise) || paise <= 0) {
      setError('Transfer amount must be greater than ₹0.');
      return;
    }
    setError('');
    setCheckingBalance(true);
    try {
      const quote = await requestApi('/api/wallet/transfers/quote', {
        method: 'POST',
        body: JSON.stringify({ recipientWalletId: recipient.walletId, amountPaise: paise }),
      });
      setAmountPaise(paise);
      setBalanceAtConfirmationPaise(Math.round(quote.availableBalance * 100));
      onWalletUpdate((current) => ({ ...current, balance: quote.availableBalance }));
      setView('confirm');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setCheckingBalance(false);
    }
  };

  const submitTransfer = async (event) => {
    event.preventDefault();
    if (busy || pin.length !== 4 || !recipient || amountPaise <= 0) return;
    setBusy(true);
    setError('');
    if (!transferKeyRef.current) {
      transferKeyRef.current = globalThis.crypto?.randomUUID?.() || `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      const result = await requestApi('/api/wallet/transfers/execute', {
        method: 'POST',
        body: JSON.stringify({
          recipientWalletId: recipient.walletId,
          amountPaise,
          pin,
          idempotencyKey: transferKeyRef.current,
        }),
      });
      setTransfer(result.transfer);
      setPin('');
      setPinOpen(false);
      setView('success');
      onWalletUpdate((current) => ({
        ...current,
        balance: result.senderBalance,
        transactions: result.senderTransaction
          ? [result.senderTransaction, ...current.transactions.filter((item) => item.id !== result.senderTransaction.id)]
          : current.transactions,
      }));
      requestApi('/api/wallet')
        .then((updated) => { if (updated.wallet) onWalletUpdate(updated.wallet); })
        .catch((refreshError) => setError(`Transfer completed, but the wallet balance could not be refreshed: ${refreshError.message}`));
    } catch (requestError) {
      setPin('');
      if (requestError.status === 402) {
        setPinOpen(false);
        setView('amount');
        setError(requestError.message);
      } else {
        setError(requestError.status === 423
          ? 'Wallet security verification failed. Please unlock your wallet again.'
          : requestError.status >= 500 || !requestError.status
            ? 'Something went wrong while processing the transfer. Please try again.'
            : requestError.message || 'We could not complete the transfer. No money was deducted. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const resetTransfer = () => {
    setRecipient(null);
    setRecipientSuffix('');
    setAmount('');
    setAmountPaise(0);
    setBalanceAtConfirmationPaise(null);
    setError('');
    setView('recipient');
    transferKeyRef.current = '';
  };

  return <section className="wallet-transfer-workspace">
    <header className="wallet-transfer-heading"><span className="eyebrow">Secure wallet transfer</span><h1>{view === 'create-id' || view === 'created-id' ? 'Create Wallet ID' : view === 'success' ? 'Transfer Successful' : 'Transfer Money'}</h1><p>{view === 'checking-id' ? 'Checking your Wallet ID...' : 'Send funds to another Innovation Labs wallet.'}</p></header>

    {view === 'checking-id' && <div className="wallet-transfer-loading" role="status"><div className="spinner" /><p>Checking your Wallet ID...</p></div>}
    {view === 'error' && <section className="wallet-transfer-panel"><div className="voice-error" role="alert">{error}</div><button className="secondary-btn" onClick={() => setView('create-id')}>Retry</button></section>}

    {view === 'create-id' && <section className="wallet-transfer-panel wallet-id-create-panel"><h2>Create your Wallet ID</h2><p>Your Wallet ID will be used by other Innovation Labs users to send money to your wallet.</p><label className="wallet-amount">Wallet ID<div className="wallet-id-input"><span aria-hidden="true">@WL</span><input value={walletIdSuffix} onChange={(event) => { setWalletIdSuffix(suffixFromInput(event.target.value)); setError(''); }} maxLength={8} autoComplete="off" aria-label="Four letters followed by four numbers" placeholder="ABCD1234" /></div></label><ul className="wallet-id-rules"><li>Exactly 4 letters</li><li>Exactly 4 numbers</li><li>Letters and numbers are both required</li><li>Wallet IDs are unique and permanent</li></ul>{error && <div className="voice-error" role="alert">{error}</div>}<div className="modal-actions"><button className="secondary-btn" onClick={onBackToOverview}>Cancel</button><button className="primary-btn" disabled={creatingId || !/^[A-Z]{4}\d{4}$/.test(walletIdSuffix)} onClick={createWalletId}>{creatingId ? 'Creating...' : 'Create ID'}</button></div></section>}

    {view === 'created-id' && <section className="wallet-transfer-panel wallet-id-success-panel"><div className="transfer-success-icon" aria-hidden="true">✓</div><h2>Wallet ID Created</h2><p>Your Wallet ID has been successfully created. You can share it with another Innovation Labs user so they can transfer money to your wallet.</p><strong className="wallet-id-display">{walletId}</strong><button className="primary-btn" onClick={() => { setError(''); setView('recipient'); }}>Continue to Transfer Money</button></section>}

    {view === 'recipient' && <section className="wallet-transfer-panel"><h2>Transfer Money</h2><div className="wallet-id-summary"><span>Your Wallet ID</span><strong>{ownWalletId || 'Loading Wallet ID...'}</strong></div><form className="wallet-transfer-form" onSubmit={checkRecipient}><label className="wallet-amount">Recipient Wallet ID<div className="wallet-id-input"><span aria-hidden="true">@WL</span><input value={recipientSuffix} onChange={(event) => { setRecipientSuffix(suffixFromInput(event.target.value)); setError(''); setRecipient(null); transferKeyRef.current = ''; }} maxLength={8} autoComplete="off" aria-label="Recipient letters and numbers" placeholder="ABCD1234" /></div></label>{error && <div className="voice-error" role="alert">{error}</div>}<button className="primary-btn" disabled={recipientBusy || !validRecipientSuffix}>{recipientBusy ? 'Checking recipient...' : 'Check Recipient'}</button></form></section>}

    {view === 'amount' && recipient && <section className="wallet-transfer-panel"><h2>Transfer Money</h2><div className="wallet-transfer-recipient"><span>Recipient</span><strong>{recipient.walletId}</strong><p>Recipient: {recipient.displayName}</p></div><form className="wallet-transfer-form" onSubmit={continueToConfirmation}><label className="wallet-amount">Amount (₹)<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} disabled={checkingBalance} onChange={(event) => { setAmount(event.target.value); setError(''); transferKeyRef.current = ''; }} placeholder="0.00" /></label><div className="wallet-transfer-balance"><span>Available Balance</span><strong>₹{Number(wallet.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>{error && <div className="voice-error" role="alert">{error}</div>}<button className="primary-btn" disabled={!amount || checkingBalance}>{checkingBalance ? 'Checking balance...' : 'Continue'}</button></form></section>}

    {view === 'confirm' && recipient && <section className="wallet-transfer-panel"><h2>Confirm Transfer</h2><dl className="wallet-transfer-summary"><div><dt>Recipient</dt><dd>{recipient.walletId}<small>{recipient.displayName}</small></dd></div><div><dt>Amount</dt><dd>₹{(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Your wallet balance</dt><dd>₹{((balanceAtConfirmationPaise ?? availablePaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Balance after transfer</dt><dd>₹{(((balanceAtConfirmationPaise ?? availablePaise) - amountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div></dl><p>Are you sure you want to transfer ₹{(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}?</p>{error && <div className="voice-error" role="alert">{error}</div>}<div className="modal-actions"><button className="secondary-btn" onClick={() => { setView('amount'); setError(''); }}>Back</button><button className="primary-btn" onClick={() => { setPin(''); setError(''); setPinOpen(true); }}>Confirm Transfer</button></div></section>}

    {view === 'success' && transfer && <section className="wallet-transfer-panel wallet-transfer-success"><div className="transfer-success-icon" aria-hidden="true">✓</div><h2>Transfer Successful</h2><strong className="transfer-success-amount">₹{Number(transfer.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong><p>Money was successfully transferred to:</p><strong>{transfer.recipientWalletId}</strong><dl className="wallet-transfer-summary"><div><dt>Transfer ID</dt><dd>{transfer.transferId}</dd></div><div><dt>Your new wallet balance</dt><dd>₹{Number(wallet.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div></dl><button className="primary-btn" onClick={resetTransfer}>Back to Transfer Money</button></section>}

    {recipientConfirmOpen && recipient && <div className="wallet-lock-overlay"><section className="wallet-pin-modal transfer-intro-modal" role="dialog" aria-modal="true" aria-labelledby="recipient-confirm-title"><h2 id="recipient-confirm-title">Confirm Recipient</h2><p>You are about to send money to:</p><strong className="wallet-id-display">{recipient.walletId}</strong><p>Recipient: {recipient.displayName}</p><p>Please verify that this is the correct recipient before continuing.</p><div className="modal-actions"><button className="secondary-btn" onClick={() => setRecipientConfirmOpen(false)}>Cancel</button><button className="primary-btn" onClick={confirmRecipient}>Yes, Continue</button></div></section></div>}

    {pinOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal transfer-pin-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-pin-title" onSubmit={submitTransfer}><h2 id="transfer-pin-title">Wallet Security</h2><p>Enter your 4-digit Wallet PIN to confirm this transfer.</p><PinBoxes value={pin} onChange={(value) => { setPin(value); setError(''); }} disabled={busy} />{error && <p className="voice-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-btn" disabled={busy} onClick={() => { setPinOpen(false); setPin(''); }}>Cancel</button><button type="submit" className="primary-btn" disabled={busy || pin.length !== 4}>{busy ? 'Processing transfer...' : 'Confirm Transfer'}</button></div></form></div>}
  </section>;
}

function WalletAccessPinModal({ mode, checking = false, onCancel, onSubmit }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (busy || pin.length !== 4) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(pin, mode);
    } catch (requestError) {
      setPin('');
      setError(requestError.message || 'Wallet verification failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return <div className="wallet-lock-overlay"><form className="wallet-pin-modal wallet-access-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-security-title" onSubmit={submit}>
    <h2 id="wallet-security-title">{mode === 'setup' ? 'Create your Wallet Security PIN' : 'Wallet Security'}</h2>
    <p>{mode === 'setup' ? 'Create a 4-digit PIN to protect your wallet.' : 'Please enter your designated 4-digit PIN.'}</p>
    <PinBoxes value={pin} onChange={(value) => { setPin(value); setError(''); }} autoFocus={!checking} disabled={busy || checking} />
    {error && <p className="voice-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="secondary-btn" disabled={busy} onClick={onCancel}>Back</button><button type="submit" className="primary-btn" disabled={busy || checking || pin.length !== 4}>{checking ? 'Checking...' : busy ? 'Verifying...' : mode === 'setup' ? 'Create PIN' : 'Unlock Wallet'}</button></div>
  </form></div>;
}

function WalletPinModal({ onCancel, onSubmit }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await onSubmit(pin);
    } catch (requestError) {
      setError(requestError.status >= 500 || !requestError.status
        ? 'Something went wrong while processing your payment. Please try again.'
        : requestError.message || 'Payment could not be completed. Please try again.');
    }
  };
  return <div className="modal-content wallet-pin-modal"><h3>Confirm Wallet Payment</h3><p>Enter your 4-digit Wallet PIN to authorize this payment.</p><PinBoxes value={pin} onChange={setPin} /><>{error && <p className="voice-error" role="alert">{error}</p>}</><div className="modal-actions"><button className="secondary-btn" onClick={onCancel}>Cancel</button><button className="primary-btn" disabled={pin.length !== 4} onClick={submit}>Confirm Payment</button></div></div>;
}

function RefundTimeline({ refund }) {
  const history = refund.statusHistory || [];
  return <ol className="refund-timeline">{history.map((item, index) => (
    <li className={`refund-stage ${index === history.length - 1 ? 'current' : 'complete'}`} key={`${item.status}-${item.createdAt}-${index}`}>
      <span aria-hidden="true">{index === history.length - 1 ? '●' : '✓'}</span>
      <div><strong>{refundStatusLabel(item.status)}</strong><p>{item.note || 'Status updated.'}</p><small>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</small></div>
    </li>
  ))}</ol>;
}

function RefundRequestPage({ auth, onSubmitted }) {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [pageState, setPageState] = useState('loading');
  const [orderData, setOrderData] = useState(null);
  const [refund, setRefund] = useState(null);
  const [stage, setStage] = useState('agreement');
  const [reasonCategory, setReasonCategory] = useState('Damaged item');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth) return undefined;
    let active = true;
    setPageState('loading');
    requestApi(`/api/refunds/eligibility/${encodeURIComponent(orderId)}`).then(async (result) => {
      if (!active) return;
      setOrderData(result.order);
      if (result.refund) {
        const existing = await requestApi(`/api/refunds/${result.refund._id}`);
        if (active) {
          setRefund(existing.refund);
          setPageState('existing');
        }
      } else if (!result.eligibility.eligible) {
        setError(result.eligibility.reason);
        setPageState('ineligible');
      } else {
        setPageState('ready');
        setStage('agreement');
      }
    }).catch((requestError) => {
      if (active) {
        setError(requestError.message);
        setPageState('error');
      }
    });
    return () => { active = false; };
  }, [auth, orderId]);

  useEffect(() => {
    if (!evidence) {
      setPreviewUrl('');
      return undefined;
    }
    const objectUrl = URL.createObjectURL(evidence);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [evidence]);

  const chooseEvidence = (event) => {
    const file = event.target.files?.[0] || null;
    setError('');
    if (!file) {
      setEvidence(null);
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setEvidence(null);
      setError('Choose a JPEG, PNG, or WebP image.');
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setEvidence(null);
      setError('Evidence images must be 5 MB or smaller.');
      event.target.value = '';
      return;
    }
    setEvidence(file);
  };

  const submitRequest = async (event) => {
    event.preventDefault();
    if (!evidence || !reason.trim() || busy) {
      setError(!evidence ? 'Upload a photo of the item as refund evidence.' : 'Enter a reason for the refund request.');
      return;
    }
    if (reasonCategory === 'Other' && reason.trim().length < 10) {
      setError('Other reasons need at least 10 characters.');
      return;
    }
    setBusy(true);
    setError('');
    const formData = new FormData();
    formData.append('orderId', orderData.orderId);
    formData.append('reasonCategory', reasonCategory);
    formData.append('reason', reason.trim());
    formData.append('evidence', evidence);
    try {
      const result = await requestApi('/api/refunds', { method: 'POST', body: formData });
      setRefund(result.refund);
      onSubmitted(result.refund);
      setPageState('submitted');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!auth) return <SignInRequiredPage onSignIn={() => { window.location.href = '/'; }} />;
  if (pageState === 'loading') return <main className="page-shell"><div className="container loader-wrap"><div className="spinner" /><p>Checking refund eligibility...</p></div></main>;
  if (pageState === 'error') return <main className="page-shell"><div className="container refund-shell"><div className="alert-box" role="alert">{error}</div><Link className="secondary-btn" to="/orders">Back to My Orders</Link></div></main>;
  if (pageState === 'ineligible') return <main className="page-shell"><div className="container refund-shell"><span className="eyebrow">Refund Request</span><h1>Order #{orderId}</h1><div className="alert-box">{error}</div><Link className="secondary-btn" to="/orders">Back to My Orders</Link></div></main>;
  if ((pageState === 'submitted' || pageState === 'existing') && refund) return <main className="page-shell"><div className="container refund-shell refund-success-page">
    <span className="eyebrow">Refund Case</span><div className="success-badge" aria-hidden="true">✓</div><h1>{pageState === 'submitted' ? 'Refund Request Placed' : refundStatusLabel(refund.status)}</h1>
    <p>{pageState === 'submitted' ? 'Your refund request has been submitted successfully.' : 'This order already has a refund case.'}</p>
    <dl className="refund-request-facts"><div><dt>Refund Case ID</dt><dd>{refund.refundCaseId}</dd></div><div><dt>Order ID</dt><dd>{refund.orderId}</dd></div><div><dt>Status</dt><dd>{refundStatusLabel(refund.status)}</dd></div></dl>
    {refund.adminReason && <div className="alert-box">Reason: {refund.adminReason}</div>}
    <h2>Refund Timeline</h2><RefundTimeline refund={refund} />
    <button className="primary-btn" onClick={() => navigate(`/refunds/${refund._id}`)}>View Refund Status</button>
  </div></main>;

  return <main className="page-shell"><div className="container refund-request-shell">
    <span className="eyebrow">Refund Request</span><h1>Order #{orderData.orderId}</h1>
    <section className="refund-request-facts"><div><span>Customer</span><strong>{orderData.userName}</strong></div><div><span>Order Date</span><strong>{new Date(orderData.createdAt).toLocaleDateString()}</strong></div><div><span>Delivered Date</span><strong>{new Date(orderData.deliveredAt).toLocaleDateString()}</strong></div><div><span>Original Order Amount</span><strong>₹{Number(orderData.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></section>
    <section className="refund-request-items"><h2>Items in this order</h2>{orderData.items.map((item) => <div key={item.id}><span>{item.name} × {item.quantity}</span><strong>₹{(item.price * item.quantity).toLocaleString('en-IN')}</strong></div>)}</section>
    {stage === 'terms' ? <section className="refund-terms-content"><h2>Refund Terms & Return Process</h2><ol><li>Submit your refund request for review.</li><li>Keep the item ready at the provided delivery/return address as instructed.</li><li>Our representative or courier will collect the item according to the return process.</li><li>After it is received, our team will inspect it and compare it with the original order.</li><li>The item must satisfy the applicable refund conditions.</li><li>If the item is incorrect, materially different, or fails those conditions, the request may be declined.</li><li>If the item passes inspection, the refund will proceed for the amount calculated by the server. You cannot choose an arbitrary amount.</li></ol><button className="primary-btn" onClick={() => setStage('form')}>I Understand & Continue</button></section> : stage === 'form' ? <form className="refund-request-form" onSubmit={submitRequest}>
      <h2>Refund Reason</h2><label>Reason<select value={reasonCategory} onChange={(event) => setReasonCategory(event.target.value)}><option>Damaged item</option><option>Wrong item received</option><option>Item does not match order</option><option>Product issue</option><option>Other</option></select></label>
      <label>Explain the issue<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required placeholder="Describe what happened with the item." /></label>
      <label>Upload Photo / Evidence<input type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseEvidence} required /></label>
      {evidence && <div className="refund-evidence-preview">{previewUrl && <img src={previewUrl} alt="Selected refund evidence" />}<span>{evidence.name} · {(evidence.size / 1024 / 1024).toFixed(2)} MB</span></div>}
      {error && <div className="voice-error" role="alert">{error}</div>}
      <button className="primary-btn" disabled={busy || !evidence}>{busy ? 'Submitting Request...' : 'Submit Refund Request'}</button>
    </form> : null}
    {error && stage !== 'form' && <div className="voice-error" role="alert">{error}</div>}
    {stage === 'agreement' && <div className="wallet-lock-overlay"><section className="wallet-pin-modal refund-agreement-modal" role="dialog" aria-modal="true" aria-labelledby="refund-agreement-title"><h2 id="refund-agreement-title">Refund Request</h2><p>You are applying for a refund. By continuing, you confirm that you have read and agree to our refund terms and conditions.</p><div className="modal-actions"><button className="secondary-btn" onClick={() => navigate('/orders')}>Cancel</button><button className="primary-btn" onClick={() => setStage('terms')}>OK, Continue</button></div></section></div>}
  </div></main>;
}

function RefundStatusPage({ auth }) {
  const { id } = useParams();
  const [refund, setRefund] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!auth) return undefined;
    let active = true;
    let inFlight = false;
    setLoading(true);
    setError('');
    const refresh = async (initial = false) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await requestApi(`/api/refunds/${encodeURIComponent(id)}`);
        if (active) setRefund(result.refund);
      } catch (requestError) {
        if (active && initial) setError(requestError.message);
      } finally {
        inFlight = false;
        if (active && initial) setLoading(false);
      }
    };
    refresh(true);
    const interval = window.setInterval(() => refresh(), 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, [auth, id]);
  if (!auth) return <SignInRequiredPage onSignIn={() => { window.location.href = '/'; }} />;
  if (loading) return <main className="page-shell"><div className="container loader-wrap"><div className="spinner" /><p>Loading refund status...</p></div></main>;
  if (error || !refund) return <main className="page-shell"><div className="container refund-shell"><div className="alert-box" role="alert">{error || 'Refund case was not found.'}</div></div></main>;
  const rejected = ['ORDER_DECLINED', 'REFUND_REJECTED'].includes(refund.status);
  return <main className="page-shell"><div className="container refund-shell"><span className="eyebrow">Refund Case</span><h1>{refund.refundCaseId}</h1><p>Order #{refund.orderId}</p>
    <div className={`refund-status-banner ${rejected ? 'is-rejected' : refund.status === 'REFUND_COMPLETED' ? 'is-complete' : ''}`}><strong>{refundStatusLabel(refund.status)}</strong><span>{rejected ? 'This case is closed.' : refund.status === 'REFUND_INITIATED' ? 'Your refund has been initialized and is expected to be credited within 3–5 business days.' : refund.status === 'REFUND_COMPLETED' ? `₹${((refund.approvedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN')} has been credited to your Innovation Labs Wallet.` : 'Our team is reviewing the next step.'}</span></div>
    <dl className="refund-request-facts"><div><dt>Original Order Amount</dt><dd>₹{((refund.originalOrderAmountPaise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Calculated Refund</dt><dd>₹{((refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Approved Refund</dt><dd>₹{((refund.approvedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div></dl>
    {refund.adminReason && <div className="alert-box"><strong>Refund Declined</strong><p>Reason: {refund.adminReason}</p></div>}
    <h2>Refund Timeline</h2><RefundTimeline refund={refund} />
  </div></main>;
}

function AdminRefundsPage({ auth, refunds, error }) {
  const [currentRefunds, setCurrentRefunds] = useState(refunds || []);
  const [refreshError, setRefreshError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth?.isAdmin) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    requestApi('/api/admin/refunds')
      .then((result) => {
        if (active) {
          setCurrentRefunds(result.refunds || []);
          setRefreshError('');
        }
      })
      .catch((requestError) => {
        if (active) setRefreshError(`Refund requests could not be loaded: ${requestError.message}`);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [auth]);

  if (!auth?.isAdmin) return <SignInRequiredPage onSignIn={() => { window.location.href = '/'; }} />;
  return <main className="page-shell"><div className="container"><div className="section-title left"><span className="eyebrow">Admin Workspace</span><h2>Refunds</h2></div>{(error || refreshError) && <div className="alert-box" role="alert">{refreshError || error}</div>}{loading ? <p className="account-loading">Loading refund requests...</p> : <div className="custom-order-grid">{currentRefunds.length ? currentRefunds.map((refund) => <article className="custom-order-card" key={refund._id}><h3>{refund.refundCaseId}</h3><div className="order-row"><span>Order</span><strong>#{refund.orderId}</strong></div><div className="order-row"><span>Customer</span><strong>{refund.userName}</strong></div><div className="order-row"><span>Email</span><strong>{refund.userEmail}</strong></div><div className="order-row"><span>Items</span><strong>{refund.itemsSnapshot?.map((item) => `${item.name} × ${item.quantity}`).join(', ') || 'Order snapshot available in case'}</strong></div><div className="order-row"><span>Original Amount</span><strong>₹{((refund.originalOrderAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN')}</strong></div><div className="order-row"><span>Calculated Refund</span><strong>₹{((refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN')}</strong></div><div className="order-row"><span>Reason</span><strong>{refund.reasonCategory}: {refund.reason}</strong></div>{refund.walletTransactionReferenceId && <div className="order-row"><span>Wallet Transaction</span><strong>{refund.walletTransactionReferenceId}</strong></div>}<div className="order-row"><span>Requested</span><strong>{new Date(refund.createdAt).toLocaleString()}</strong></div><div className="order-row"><span>Status</span><strong>{refundStatusLabel(refund.status)}</strong></div><Link className="primary-btn small" to={`/admin/refunds/${refund._id}`}>Open</Link></article>) : !refreshError && <AccountEmpty text="No refund requests yet." />}</div>}</div></main>;
}

function AdminRefundDetailPage({ auth, onUpdated }) {
  const { id } = useParams();
  const [refund, setRefund] = useState(null);
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [approvedAmount, setApprovedAmount] = useState('');

  useEffect(() => {
    if (!auth?.isAdmin) return undefined;
    let active = true;
    requestApi(`/api/admin/refunds/${encodeURIComponent(id)}`).then((result) => {
      if (!active) return;
      setRefund(result.refund);
      setOrder(result.order);
      setApprovedAmount(((result.refund.approvedRefundAmountPaise ?? result.refund.refundAmountPaise) / 100).toFixed(2));
    }).catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [auth, id]);

  const runAction = async () => {
    if (!pendingAction || busy) return;
    setBusy(true);
    setError('');
    try {
      let result;
      if (pendingAction.action === 'credit') {
        result = await requestApi(`/api/admin/refunds/${id}/credit`, { method: 'POST' });
      } else if (pendingAction.action === 'amount') {
        const amountPaise = Math.round(Number(approvedAmount) * 100);
        result = await requestApi(`/api/admin/refunds/${id}/amount`, { method: 'PATCH', body: JSON.stringify({ amountPaise }) });
      } else {
        result = await requestApi(`/api/admin/refunds/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ action: pendingAction.action, reason: declineReason }),
        });
      }
      setRefund(result.refund);
      onUpdated(result.refund);
      if (pendingAction.action === 'amount') setApprovedAmount(((result.refund.approvedRefundAmountPaise ?? result.refund.refundAmountPaise) / 100).toFixed(2));
      setPendingAction(null);
      setDeclineReason('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!auth?.isAdmin) return <SignInRequiredPage onSignIn={() => { window.location.href = '/'; }} />;
  if (loading) return <main className="page-shell"><div className="container loader-wrap"><div className="spinner" /><p>Loading refund case...</p></div></main>;
  if (error && !refund) return <main className="page-shell"><div className="container refund-shell"><div className="alert-box">{error}</div><Link to="/admin/refunds">Back to Refunds</Link></div></main>;
  if (!refund) return null;

  const nextStep = {
    REFUND_PLACED: { action: 'check', label: 'Start Order Check', message: 'You are about to start reviewing this refund request.' },
    ORDER_CHECKING: { action: 'return', label: 'Require Return / Collection', message: 'You are about to request return or collection of the item.' },
    RETURN_REQUIRED: { action: 'arrived', label: 'Package Arrived', message: 'Confirm that the returned package has arrived.' },
    PACKAGE_ARRIVED: { action: 'inspect', label: 'Start Part Checking', message: 'You are about to begin inspection of the returned item.' },
    ORDER_ACCEPTED: { action: 'process', label: 'Start Refund Processing', message: 'You are about to move the accepted refund into processing.' },
    REFUND_PROCESSING: { action: 'initiate', label: 'Initialize Refund', message: 'You are about to initialize the approved refund.' },
  }[refund.status];
  const rejection = ['ORDER_DECLINED', 'REFUND_REJECTED'].includes(refund.status);
  const deliveryAddress = order?.address || refund.orderSnapshot?.address || {};
  const approvedPaise = refund.approvedRefundAmountPaise ?? refund.refundAmountPaise;

  return <main className="page-shell"><div className="container refund-admin-case">
    <Link className="back-link" to="/admin/refunds">← Refunds</Link>
    <div className="section-title left"><span className="eyebrow">Admin Workspace · Refund Case</span><h1>{refund.refundCaseId}</h1><p>Order #{refund.orderId} · {refundStatusLabel(refund.status)}</p></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    <div className="refund-admin-grid">
      <section className="refund-admin-panel"><h2>Customer</h2><dl><div><dt>Name</dt><dd>{refund.userName}</dd></div><div><dt>Email</dt><dd>{refund.userEmail}</dd></div><div><dt>Phone</dt><dd>{deliveryAddress.phoneNumber || 'Not provided'}</dd></div></dl></section>
      <section className="refund-admin-panel"><h2>Original Order</h2><dl><div><dt>Order Date</dt><dd>{new Date(order?.createdAt || refund.orderSnapshot?.createdAt || refund.createdAt).toLocaleString()}</dd></div><div><dt>Delivered</dt><dd>{refund.orderSnapshot?.deliveredAt ? new Date(refund.orderSnapshot.deliveredAt).toLocaleString() : 'Not available'}</dd></div><div><dt>Payment</dt><dd>{order?.paymentMethod || refund.orderSnapshot?.paymentMethod || 'Not available'}</dd></div><div><dt>Original Amount</dt><dd>₹{((refund.originalOrderAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Address</dt><dd>{[deliveryAddress.fullName, deliveryAddress.addressLine1, deliveryAddress.addressLine2, deliveryAddress.city, deliveryAddress.state, deliveryAddress.pinCode, deliveryAddress.country].filter(Boolean).join(', ') || 'Not provided'}</dd></div></dl></section>
      <section className="refund-admin-panel"><h2>Items</h2><div className="refund-request-items">{(refund.itemsSnapshot?.length ? refund.itemsSnapshot : order?.items || []).map((item, index) => <div key={`${item.id || item.name}-${index}`}><span>{item.name} × {item.quantity}</span><strong>₹{(Number(item.price) * Number(item.quantity)).toLocaleString('en-IN')}</strong></div>)}</div></section>
      <section className="refund-admin-panel"><h2>Refund Request</h2><p><strong>{refund.reasonCategory}: </strong>{refund.reason}</p><p><strong>Status:</strong> {refundStatusLabel(refund.status)}</p><p><strong>Original order:</strong> ₹{((refund.originalOrderAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p><p><strong>Calculated maximum:</strong> ₹{((refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>{refund.evidence?.fileName && <p><a href={`/api/refunds/${refund._id}/evidence`} target="_blank" rel="noreferrer">View evidence: {refund.evidence.fileName}</a></p>}{refund.adminReason && <div className="alert-box">Declined: {refund.adminReason}</div>}</section>
    </div>
    {refund.status === 'ORDER_ACCEPTED' && <section className="refund-admin-panel refund-amount-editor"><h2>Approved Refund Amount</h2><p>Calculated eligible maximum: ₹{((refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p><label>Refund Amount (₹)<input type="number" min="0.01" max={((refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toFixed(2)} step="0.01" value={approvedAmount} onChange={(event) => setApprovedAmount(event.target.value)} /></label><button className="secondary-btn" disabled={busy || !approvedAmount} onClick={() => setPendingAction({ action: 'amount', label: 'Save Refund Amount', message: `Confirm the approved refund amount of ₹${Number(approvedAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.` })}>Save Amount</button></section>}
    <section className="refund-admin-panel"><h2>Refund Timeline</h2><RefundTimeline refund={refund} /></section>
    {refund.adminAudit?.length > 0 && <section className="refund-admin-panel"><h2>Admin Audit</h2><div className="refund-audit-list">{refund.adminAudit.map((entry, index) => <article key={`${entry.timestamp}-${index}`}><strong>{entry.action.replaceAll('_', ' ')}</strong><span>{entry.adminId} · {new Date(entry.timestamp).toLocaleString()}</span>{entry.reason && <p>{entry.reason}</p>}</article>)}</div></section>}
    <div className="refund-admin-actions">
      {nextStep && <button className="primary-btn" disabled={busy} onClick={() => setPendingAction(nextStep)}>{nextStep.label}</button>}
      {refund.status === 'PART_CHECKING' && <><button className="primary-btn" disabled={busy} onClick={() => setPendingAction({ action: 'accept', label: 'Accept Refund', message: 'Confirm that the returned item passed inspection and this refund can proceed.' })}>Accept Refund</button><button className="secondary-btn" disabled={busy} onClick={() => setPendingAction({ action: 'decline', label: 'Decline Refund', message: 'Confirm that this refund request should be declined. A reason is required.' })}>Decline Refund</button></>}
      {refund.status === 'REFUND_INITIATED' && <button className="primary-btn" disabled={busy} onClick={() => setPendingAction({ action: 'credit', label: 'Confirm Refund', message: `Credit ₹${(approvedPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} to the customer's Innovation Labs Wallet and complete this refund?` })}>Refund ₹{(approvedPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</button>}
      {rejection && <span className="refund-order-stamp">REFUND DECLINED</span>}
    </div>
    {pendingAction && <div className="wallet-lock-overlay"><section className="wallet-pin-modal refund-agreement-modal" role="dialog" aria-modal="true"><h2>{pendingAction.label}</h2><p>{pendingAction.message}</p>{pendingAction.action === 'decline' && <label>Decline reason<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} maxLength={1000} required /></label>}<div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button><button className="primary-btn" disabled={busy || (pendingAction.action === 'decline' && !declineReason.trim())} onClick={runAction}>{busy ? 'Processing...' : pendingAction.label}</button></div></section></div>}
  </div></main>;
}

function AdminVerificationModal({ onCancel, onVerify }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await onVerify(password);
    } catch (verifyError) {
      setError(verifyError.message || 'Admin verification could not be completed. Please try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return <form className="modal-content admin-verify-form" onSubmit={submit}>
    <div><span className="eyebrow">Restricted access</span><h3>Admin Verification</h3></div>
    <label htmlFor="admin-password">Enter Admin Password</label>
    <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required />
    {error && <div className="voice-error" role="alert">{error}</div>}
    <div className="modal-actions"><button className="secondary-btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary-btn" disabled={busy || !password}>{busy ? 'Verifying...' : 'Verify'}</button></div>
  </form>;
}

function AdminDashboardPage() {
  const adminSections = [
    ['/admin/orders', 'Orders', 'Review the live order queue, approvals, and delivery estimates.'],
    ['/admin/rewards', 'Reward Points', 'Review reward balances, earning history, conversions, and earning rules.'],
    ['/admin/product-reviews', 'Product Reviews', 'Moderate verified customer product reviews and uploaded images.'],
    ['/admin/promo-codes', 'Wallet Promo Codes', 'Create and track codes that add value to customer wallets.'],
    ['/admin/discount-codes', 'Discount Promo Codes', 'Create product discounts and review purchases and redemptions.'],
    ['/admin/scratch-cards', 'Scratch Card Management', 'Configure scratch rewards and review issued cards.'],
    ['/admin/invoices', 'Invoice Management', 'Search paid invoices and download original PDF records.'],
    ['/admin/inventory', 'Inventory', 'Track product stock levels, availability, and restock signals.'],
    ['/admin/custom-requests', 'Custom Requests', 'Review and manage customer requests for unavailable parts.'],
    ['/admin/credit-purchases', 'AI Credits', 'Review purchased credits, payment methods, and statuses.'],
    ['/admin/settings', 'Settings', 'Adjust operational limits and shop capacity.'],
    ['/admin/refunds', 'Refunds', 'Review returned orders and process approved wallet refunds.'],
  ];
  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Innovation Labs</span><h2>Admin Panel</h2></div><div className="admin-dashboard-grid">{adminSections.map(([to, title, description]) => <Link className="admin-dashboard-card" to={to} key={to}><span className="eyebrow">Manage</span><h3>{title}</h3><p>{description}</p><strong>Open section <span aria-hidden="true">→</span></strong></Link>)}</div></div>;
}

function AdminProductReviewsPage() {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyReview, setBusyReview] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    setLoading(true);
    try {
      const result = await requestApi('/api/admin/product-reviews');
      setReviews(result.reviews || []);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);
  const moderate = async (review, status) => {
    setBusyReview(review.reviewId);
    setError('');
    setNotice('');
    try {
      await requestApi(`/api/admin/product-reviews/${encodeURIComponent(review.reviewId)}/moderation`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setNotice(`Review ${status}.`);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyReview('');
    }
  };
  const pending = reviews.filter((review) => review.moderationStatus === 'pending');
  return <div className="admin-panel-wrap admin-feature-page">
    <div className="section-title left"><span className="eyebrow">Admin · Customer Feedback</span><h2>Product Review Management</h2></div>
    {error && <div className="alert-box" role="alert">{error}</div>}{notice && <div className="account-notice" role="status">{notice}</div>}
    {loading ? <p className="account-loading">Loading submitted product reviews...</p> : pending.length ? <div className="product-review-admin-list">{pending.map((review) => <article className="admin-panel product-review-admin-card" key={review.reviewId}>
      <div className="customer-review-heading"><strong>{review.customerName}</strong><span className="verified-purchase-badge">✓ Verified Purchase</span><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString('en-IN')}</time></div>
      <h3>{review.productName}</h3><p>Product ID: {review.productId} · Order: <Link to={`/admin/orders/${encodeURIComponent(review.orderId)}`}>#{review.orderId}</Link></p>
      <ProductStars rating={review.rating} label={`${review.rating} out of 5 stars`} />
      {review.description && <p className="product-review-admin-description">{review.description}</p>}
      {review.images.length > 0 && <div className="customer-review-images">{review.images.map((image, index) => <a href={image} target="_blank" rel="noreferrer" key={image}><img src={image} alt={`Uploaded review image ${index + 1}`} loading="lazy" /></a>)}</div>}
      <div className="product-review-admin-actions"><button className="primary-btn small" disabled={busyReview === review.reviewId} onClick={() => moderate(review, 'approved')}>{busyReview === review.reviewId ? 'Saving...' : 'Approve'}</button><button className="secondary-btn small" disabled={busyReview === review.reviewId} onClick={() => moderate(review, 'rejected')}>Reject</button></div>
    </article>)}</div> : <AccountEmpty text="There are no reviews awaiting moderation." />}
    {!loading && reviews.some((review) => review.moderationStatus !== 'pending') && <section className="admin-panel"><div className="account-panel-heading"><h3>Moderation History</h3><span>{reviews.filter((review) => review.moderationStatus !== 'pending').length} reviews</span></div><div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Customer</th><th>Product</th><th>Order</th><th>Rating</th><th>Status</th><th>Submitted</th></tr></thead><tbody>{reviews.filter((review) => review.moderationStatus !== 'pending').map((review) => <tr key={review.reviewId}><td>{review.customerName}</td><td>{review.productName}</td><td>{review.orderId}</td><td>{review.rating} / 5</td><td>{review.moderationStatus}</td><td>{new Date(review.createdAt).toLocaleDateString('en-IN')}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function AdminRewardsPage() {
  const [data, setData] = useState(null);
  const [rules, setRules] = useState({ minimumEligibleAmount: 100, firstTierMaximum: 1000, firstTierPoints: 5, higherTierPoints: 20 });
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingRules, setSavingRules] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async (search = '') => {
    setLoading(true);
    setError('');
    try {
      const suffix = search ? `?q=${encodeURIComponent(search)}` : '';
      const result = await requestApi(`/api/admin/rewards${suffix}`);
      setData(result);
      setRules(result.rules || rules);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const searchTransactions = (event) => {
    event.preventDefault();
    load(query.trim());
  };

  const saveRules = async (event) => {
    event.preventDefault();
    setSavingRules(true);
    setError('');
    setNotice('');
    try {
      const result = await requestApi('/api/admin/rewards/rules', { method: 'PUT', body: JSON.stringify(rules) });
      setRules(result.rules);
      setNotice('Reward earning rules updated. New eligible orders will use these values.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingRules(false);
    }
  };

  const totals = data?.totals || { issuedPoints: 0, redeemedPoints: 0, reversedPoints: 0, transactionCount: 0 };
  return <div className="admin-panel-wrap admin-rewards-page">
    <div className="section-title left"><span className="eyebrow">Admin · Customer Rewards</span><h2>Reward Points</h2></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    <div className="admin-reward-totals"><AccountStat label="Points issued" value={totals.issuedPoints.toLocaleString('en-IN')} /><AccountStat label="Points redeemed" value={totals.redeemedPoints.toLocaleString('en-IN')} /><AccountStat label="Points reversed" value={totals.reversedPoints.toLocaleString('en-IN')} /><AccountStat label="Ledger transactions" value={totals.transactionCount.toLocaleString('en-IN')} /></div>
    <section className="admin-panel admin-reward-rules"><div className="account-panel-heading"><h3>Earning Rules</h3><span>Values apply to future paid orders</span></div><form className="admin-reward-rule-form" onSubmit={saveRules}><label>Minimum eligible amount (₹)<input type="number" min="0" step="0.01" value={rules.minimumEligibleAmount} onChange={(event) => setRules((current) => ({ ...current, minimumEligibleAmount: event.target.value }))} /></label><label>First tier maximum (₹)<input type="number" min="0.01" step="0.01" value={rules.firstTierMaximum} onChange={(event) => setRules((current) => ({ ...current, firstTierMaximum: event.target.value }))} /></label><label>First tier points<input type="number" min="0" step="1" value={rules.firstTierPoints} onChange={(event) => setRules((current) => ({ ...current, firstTierPoints: event.target.value === '' ? '' : Number(event.target.value) }))} /></label><label>Higher tier points<input type="number" min="0" step="1" value={rules.higherTierPoints} onChange={(event) => setRules((current) => ({ ...current, higherTierPoints: event.target.value === '' ? '' : Number(event.target.value) }))} /></label><button className="primary-btn small" disabled={savingRules}>{savingRules ? 'Saving...' : 'Save Rules'}</button></form></section>
    <section className="admin-panel admin-reward-search"><div className="account-panel-heading"><h3>Customer &amp; Transaction Search</h3><span>Search customer ID, email, or order ID</span></div><form onSubmit={searchTransactions}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Customer ID, email, or order ID" aria-label="Search reward points" /><button className="primary-btn small" disabled={loading}>{loading ? 'Searching...' : 'Search'}</button><button className="secondary-btn small" type="button" disabled={loading || !query} onClick={() => { setQuery(''); load(''); }}>Clear</button></form></section>
    <section className="admin-panel"><div className="account-panel-heading"><h3>Customer Balances</h3><span>{data?.accounts?.length || 0} accounts</span></div>{loading ? <p className="account-loading">Loading balances...</p> : data?.accounts?.length ? <div className="account-table-wrap"><table className="account-table admin-reward-table"><thead><tr><th>Customer</th><th>Customer ID</th><th>Available points</th><th>Lifetime earned</th><th>Converted</th></tr></thead><tbody>{data.accounts.map((account) => <tr key={account.userId}><td>{account.customer?.name || 'Customer'}<br />{account.customer?.email || 'Email unavailable'}</td><td>{account.userId}</td><td>{account.availablePoints}</td><td>{account.lifetimePointsEarned}</td><td>{account.lifetimePointsRedeemed}</td></tr>)}</tbody></table></div> : <p className="account-empty">No reward accounts match this search.</p>}</section>
    <section className="admin-panel"><div className="account-panel-heading"><h3>Reward Transaction Ledger</h3><span>{data?.transactions?.length || 0} entries</span></div>{loading ? <p className="account-loading">Loading transactions...</p> : data?.transactions?.length ? <div className="account-table-wrap"><table className="account-table admin-reward-table"><thead><tr><th>Date</th><th>Customer</th><th>Order</th><th>Type</th><th>Eligible amount</th><th>Wallet amount</th><th>Points</th><th>Status</th><th>Transaction ID</th></tr></thead><tbody>{data.transactions.map((transaction) => <tr key={transaction.transactionId}><td>{new Date(transaction.createdAt).toLocaleDateString('en-IN')}</td><td>{transaction.customer?.email || transaction.userEmail || transaction.userId}</td><td>{transaction.orderId || '—'}</td><td>{transaction.transactionType} · {transaction.productType}</td><td>₹{(transaction.eligibleAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>₹{(transaction.walletAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{transaction.transactionType === 'reversed' || transaction.transactionType === 'redeemed' ? '−' : '+'}{transaction.points}</td><td>{transaction.status}</td><td>{transaction.transactionId}</td></tr>)}</tbody></table></div> : <p className="account-empty">No reward transactions match this search.</p>}</section>
  </div>;
}

function ProductEligibilityFields({ eligibilityType, eligibleCategories, eligibleProductIds, products, onChange, idPrefix }) {
  const categories = [...new Set(products.map((product) => product.category).filter(Boolean))].sort();
  return <div className="admin-eligibility-fields">
    <label>{idPrefix} eligible products<select value={eligibilityType} onChange={(event) => onChange({ eligibilityType: event.target.value, eligibleCategories: [], eligibleProductIds: [] })}>
      <option value="all">All eligible physical parts</option>
      <option value="categories">Selected categories</option>
      <option value="products">Selected products</option>
    </select></label>
    {eligibilityType === 'categories' && <fieldset><legend>Choose eligible categories</legend><div className="admin-eligibility-options">{categories.map((category) => <label key={category}><input type="checkbox" checked={eligibleCategories.includes(category)} onChange={(event) => onChange({ eligibleCategories: event.target.checked ? [...eligibleCategories, category] : eligibleCategories.filter((value) => value !== category) })} />{category}</label>)}</div></fieldset>}
    {eligibilityType === 'products' && <fieldset><legend>Choose eligible products</legend><div className="admin-eligibility-options">{products.map((product) => <label key={product.id}><input type="checkbox" checked={eligibleProductIds.includes(product.id)} onChange={(event) => onChange({ eligibleProductIds: event.target.checked ? [...eligibleProductIds, product.id] : eligibleProductIds.filter((value) => value !== product.id) })} />{product.name}</label>)}</div></fieldset>}
  </div>;
}

function AdminDiscountCodesPage() {
  const [offers, setOffers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [generateNewCodes, setGenerateNewCodes] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [draft, setDraft] = useState(() => {
    const local = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return { code: '', name: '', sellingPrice: '', discountType: 'fixed', discountValue: '', discountPercent: '', startsAt: local(new Date()), expiresAt: local(new Date(Date.now() + 30 * 86400000)), maxRedemptions: '100', maxRedemptionsPerCustomer: '1', availableQuantity: '100', minimumPurchase: '0', eligibilityType: 'all', eligibleCategories: [], eligibleProductIds: [], active: true };
  });
  const load = async () => {
    setLoading(true);
    try {
      const [result, catalog] = await Promise.all([requestApi('/api/admin/discount-offers'), requestApi('/api/products')]);
      setOffers(result.offers || []);
      setPurchases(result.purchases || []);
      setProducts(catalog.products || []);
      setError('');
    }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const generateCode = async () => {
    setGeneratingCode(true);
    setError('');
    try {
      const result = await requestApi('/api/admin/discount-offers/generate-code', { method: 'POST' });
      setDraft((current) => ({ ...current, code: result.code }));
    } catch (requestError) { setError(requestError.message); }
    finally { setGeneratingCode(false); }
  };
  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await requestApi('/api/admin/discount-offers', { method: 'POST', body: JSON.stringify({
        code: draft.code,
        offerName: draft.name,
        sellingPrice: draft.sellingPrice,
        discountType: draft.discountType,
        customerDiscountValue: draft.discountValue,
        discountPercent: draft.discountPercent,
        startsAt: new Date(draft.startsAt).toISOString(),
        expiresAt: new Date(draft.expiresAt).toISOString(),
        maxRedemptions: draft.maxRedemptions,
        maxRedemptionsPerCustomer: draft.maxRedemptionsPerCustomer,
        availableQuantity: draft.availableQuantity,
        minimumPurchase: draft.minimumPurchase,
        eligibilityType: draft.eligibilityType,
        eligibleCategories: draft.eligibleCategories,
        eligibleProductIds: draft.eligibleProductIds,
        active: draft.active,
      }) });
      setModalOpen(false);
      setDraft((current) => ({ ...current, code: '', name: '', sellingPrice: '', discountValue: '', discountPercent: '', eligibilityType: 'all', eligibleCategories: [], eligibleProductIds: [] }));
      setNotice('Discount Promo Code offer created successfully.');
      await load();
    } catch (requestError) { setError(requestError.message); }
    finally { setSaving(false); }
  };
  const generateStandardOffers = async () => {
    if (bulkBusy) return;
    setBulkBusy(true); setError(''); setNotice('');
    try {
      const result = await requestApi('/api/admin/discount-offers/generate-standard', {
        method: 'POST',
        body: JSON.stringify({ generateNewCodes }),
      });
      setBulkModalOpen(false);
      setGenerateNewCodes(false);
      setNotice(`${result.created.length} standard offers created; ${result.skipped.length} existing offers skipped.`);
      await load();
    } catch (requestError) { setError(requestError.message); }
    finally { setBulkBusy(false); }
  };
  const toggle = async (offer) => {
    try { await requestApi(`/api/admin/discount-offers/${encodeURIComponent(offer.id)}/status`, { method: 'PATCH', body: JSON.stringify({ active: !offer.active }) }); await load(); }
    catch (requestError) { setError(requestError.message); }
  };
  return <div className="admin-panel-wrap admin-feature-page">
    <div className="section-title left"><div><span className="eyebrow">Admin · Product Discounts</span><h2>Discount Promo Codes</h2></div><div className="discount-admin-actions"><button className="secondary-btn" onClick={() => setBulkModalOpen(true)}>✦ Make Promo Codes with AI</button><button className="primary-btn" onClick={() => setModalOpen(true)}>Create Discount Code</button></div></div>
    {error && <div className="alert-box" role="alert">{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    {loading ? <div className="empty-state"><h3>Loading discount offers...</h3></div> : offers.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Offer Name</th><th>Promo Code</th><th>Selling price</th><th>Discount value</th><th>Quantity</th><th>Purchased</th><th>Redeemed</th><th>Source</th><th>Status</th><th /></tr></thead><tbody>{offers.map((offer) => <tr key={offer.id}><td>{offer.name}</td><td><strong>{offer.code}</strong></td><td>₹{Number(offer.sellingPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{offer.discountType === 'fixed' ? `₹${(offer.discountValuePaise / 100).toLocaleString('en-IN')}` : `${offer.discountPercent}%`}</td><td>{offer.availableQuantity}</td><td>{offer.purchasedCount}</td><td>{offer.redeemedCount} / {offer.maxRedemptions}</td><td>{offer.source === 'AI_GENERATED' ? 'AI Generated' : offer.source === 'SCRATCH_CARD' ? 'Scratch Card' : 'Admin'}</td><td>{offer.active ? 'Active' : 'Inactive'}</td><td><button className="secondary-btn small" onClick={() => toggle(offer)}>{offer.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div> : <AccountEmpty text="No Discount Promo Codes have been created." />}
    <section className="admin-panel"><div className="account-panel-heading"><h3>Purchases &amp; Fulfillment</h3><span>{purchases.length} issued codes</span></div>{purchases.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Customer</th><th>Recipient</th><th>Code</th><th>Order</th><th>Order status</th><th>Fulfillment</th><th>Redemption</th><th>Expires</th></tr></thead><tbody>{purchases.map((purchase) => <tr key={purchase.purchaseId}><td>{purchase.purchaser?.email || purchase.purchaserUserId}</td><td>{purchase.recipient?.email || purchase.recipientEmail || purchase.userId}</td><td>{purchase.code}</td><td>{purchase.orderId}</td><td>{purchase.order?.orderStatus || '—'}</td><td>{purchase.fulfillmentStatus}</td><td>{purchase.redemptionCount} / {purchase.maxRedemptions}</td><td>{new Date(purchase.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table></div> : <p className="account-empty">No discount-code purchases yet.</p>}</section>
    {bulkModalOpen && <div className="wallet-lock-overlay"><section className="wallet-pin-modal discount-bulk-modal" role="dialog" aria-modal="true" aria-labelledby="discount-bulk-title">
      <h2 id="discount-bulk-title">Make Promo Codes with AI</h2>
      <p>Generate the standard Innovation Labs discount promo-code denominations?</p>
      <div className="discount-denomination-list">{[1, ...Array.from({ length: 10 }, (_, index) => (index + 1) * 100), ...Array.from({ length: 9 }, (_, index) => (index + 2) * 1000)].map((amount) => <span key={amount}>₹{amount.toLocaleString('en-IN')}</span>)}</div>
      <label className="admin-checkbox"><input type="checkbox" checked={generateNewCodes} onChange={(event) => setGenerateNewCodes(event.target.checked)} /> Generate New Codes even when active denomination offers already exist</label>
      {error && <div className="alert-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-btn" disabled={bulkBusy} onClick={() => setBulkModalOpen(false)}>Cancel</button><button type="button" className="primary-btn" disabled={bulkBusy} onClick={generateStandardOffers}>{bulkBusy ? 'Creating Offers...' : 'Create These Promo Codes'}</button></div>
    </section></div>}
    {modalOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal account-form admin-feature-form discount-admin-form" onSubmit={save}>
      <h2>Create Discount Promo Code</h2>
      <label>Offer Name<input required maxLength={100} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
      <label>Discount Promo Code<div className="admin-code-input"><input required maxLength={19} placeholder="XXXX-XXXX-XXXX-XXXX" value={draft.code} onChange={(event) => {
        const raw = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
        const code = raw.match(/.{1,4}/g)?.join('-') || '';
        setDraft((current) => ({ ...current, code }));
      }} /><button type="button" className="secondary-btn small" disabled={generatingCode || saving} onClick={generateCode}>{generatingCode ? 'Generating...' : 'Generate'}</button></div><small>Four groups of four uppercase letters or numbers.</small></label>
      <div className="admin-feature-fields">
        <label>Selling Price (₹)<input type="number" min="0" step="0.01" required value={draft.sellingPrice} onChange={(event) => setDraft((current) => ({ ...current, sellingPrice: event.target.value }))} /></label>
        <label>Discount Type<select value={draft.discountType} onChange={(event) => setDraft((current) => ({ ...current, discountType: event.target.value }))}><option value="fixed">Fixed Rupee Discount</option><option value="percentage">Percentage Discount</option></select></label>
        {draft.discountType === 'fixed' ? <label>Customer Discount Value (₹)<input type="number" min="0.01" step="0.01" required value={draft.discountValue} onChange={(event) => setDraft((current) => ({ ...current, discountValue: event.target.value }))} /></label> : <label>Customer Discount Value (%)<input type="number" min="0.01" max="100" step="0.01" required value={draft.discountPercent} onChange={(event) => setDraft((current) => ({ ...current, discountPercent: event.target.value }))} /></label>}
        <label>Minimum Purchase Amount (₹)<input type="number" min="0" step="0.01" value={draft.minimumPurchase} onChange={(event) => setDraft((current) => ({ ...current, minimumPurchase: event.target.value }))} /></label>
        <label>Available Quantity<input type="number" min="1" step="1" required value={draft.availableQuantity} onChange={(event) => setDraft((current) => ({ ...current, availableQuantity: event.target.value }))} /></label>
        <label>Maximum Redemptions<input type="number" min="1" step="1" required value={draft.maxRedemptions} onChange={(event) => setDraft((current) => ({ ...current, maxRedemptions: event.target.value }))} /></label>
        <label>Redemptions Per Customer<input type="number" min="1" step="1" required value={draft.maxRedemptionsPerCustomer} onChange={(event) => setDraft((current) => ({ ...current, maxRedemptionsPerCustomer: event.target.value }))} /></label>
        <label>Start Date and Time<input type="datetime-local" required value={draft.startsAt} onChange={(event) => setDraft((current) => ({ ...current, startsAt: event.target.value }))} /></label>
        <label>Expiry Date and Time<input type="datetime-local" required value={draft.expiresAt} onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))} /></label>
      </div>
      <ProductEligibilityFields eligibilityType={draft.eligibilityType} eligibleCategories={draft.eligibleCategories} eligibleProductIds={draft.eligibleProductIds} products={products} idPrefix="Offer" onChange={(updates) => setDraft((current) => ({ ...current, ...updates }))} />
      <label>Status<select value={draft.active ? 'active' : 'inactive'} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.value === 'active' }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      <div className="discount-value-explanation"><strong>Selling price and customer discount are separate amounts.</strong><span>The customer pays the selling price to get a product discount. The discount is never added to a wallet.</span></div>
      <div className="modal-actions"><button type="button" className="secondary-btn" disabled={saving} onClick={() => setModalOpen(false)}>Cancel</button><button className="primary-btn" disabled={saving || generatingCode || !/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(draft.code) || (draft.eligibilityType === 'categories' && !draft.eligibleCategories.length) || (draft.eligibilityType === 'products' && !draft.eligibleProductIds.length)}>{saving ? 'Saving...' : 'Create Offer'}</button></div>
    </form></div>}
  </div>;
}

function AdminScratchCardsPage() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    setLoading(true);
    try {
      const [result, catalog] = await Promise.all([requestApi('/api/admin/scratch-cards'), requestApi('/api/products')]);
      setData(result);
      setForm({ ...result.settings, rewardValues: result.settings.rewardValues.join(', ') });
      setProducts(catalog.products || []);
      setError('');
    } catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const save = async (event) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const result = await requestApi('/api/admin/scratch-cards/settings', { method: 'PUT', body: JSON.stringify({ ...form, rewardValues: String(form.rewardValues).split(',').map((value) => Number(value.trim())).filter(Number.isFinite) }) });
      setForm({ ...result.settings, rewardValues: result.settings.rewardValues.join(', ') });
      setNotice('Scratch card settings saved.');
      await load();
    } catch (requestError) { setError(requestError.message); }
    finally { setSaving(false); }
  };
  return <div className="admin-panel-wrap admin-feature-page"><div className="section-title left"><span className="eyebrow">Admin · Customer Rewards</span><h2>Scratch Card Management</h2></div>{error && <div className="alert-box">{error}</div>}{notice && <div className="account-notice">{notice}</div>}{form && <section className="admin-panel"><div className="account-panel-heading"><h3>Reward Rules</h3><span>Applies to future qualifying orders</span></div><form className="admin-scratch-form" onSubmit={save}>
    <label className="admin-checkbox admin-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} /><span>Enable Scratch Cards</span></label>
    <section className="admin-form-section"><div><h4>Eligibility</h4><p>Set the order value required to receive a reward.</p></div><div className="admin-feature-fields"><label>Minimum Eligible Order Amount (₹)<input type="number" min="0" step="0.01" value={form.threshold} onChange={(event) => setForm((current) => ({ ...current, threshold: event.target.value }))} /></label></div></section>
    <section className="admin-form-section"><div><h4>Reward Configuration</h4><p>Choose the reward type and available reward amounts.</p></div><div className="admin-feature-fields">
      <label>Discount Type<select value={form.discountType} onChange={(event) => setForm((current) => ({ ...current, discountType: event.target.value }))}><option value="fixed">Fixed Rupee Discount</option><option value="percentage">Percentage Discount</option></select></label>
      <label>Possible Discount Rewards ({form.discountType === 'fixed' ? '₹' : '%'}, comma separated)<input value={form.rewardValues} onChange={(event) => setForm((current) => ({ ...current, rewardValues: event.target.value }))} /></label>
      <label>Minimum Cart Purchase (₹)<input type="number" min="0" step="0.01" value={form.minimumPurchase} onChange={(event) => setForm((current) => ({ ...current, minimumPurchase: event.target.value }))} /></label>
    </div></section>
    <section className="admin-form-section"><div><h4>Redemption Rules</h4><p>Control how long rewards remain valid and how often they can be used.</p></div><div className="admin-feature-fields">
      <label>Code Expiry Period (days)<input type="number" min="1" step="1" value={form.expiryDays} onChange={(event) => setForm((current) => ({ ...current, expiryDays: Number(event.target.value) }))} /></label>
      <label>Maximum Redemptions<input type="number" min="1" step="1" value={form.maxRedemptions} onChange={(event) => setForm((current) => ({ ...current, maxRedemptions: Number(event.target.value) }))} /></label>
      <label className="admin-checkbox admin-toggle"><input type="checkbox" checked={form.transferable} onChange={(event) => setForm((current) => ({ ...current, transferable: event.target.checked }))} /><span>Allow transferable rewards</span></label>
    </div></section>
    <section className="admin-form-section"><div><h4>Product Eligibility</h4><p>Choose the products or categories that qualify for reward redemption.</p></div><ProductEligibilityFields eligibilityType={form.eligibilityType} eligibleCategories={form.eligibleCategories} eligibleProductIds={form.eligibleProductIds} products={products} idPrefix="Reward" onChange={(updates) => setForm((current) => ({ ...current, ...updates }))} /></section>
    <button className="primary-btn" disabled={saving}>{saving ? 'Saving...' : 'Save Scratch Settings'}</button></form></section>}{loading ? <p className="account-loading">Loading scratch cards...</p> : <section className="admin-panel"><div className="account-panel-heading"><h3>Issued Cards</h3><span>{data?.scratchCards?.length || 0} cards</span></div>{data?.scratchCards?.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Customer</th><th>Order</th><th>Eligible amount</th><th>Reward</th><th>Assigned code</th><th>Status</th><th>Issued</th><th>Revealed</th></tr></thead><tbody>{data.scratchCards.map((card) => <tr key={card.scratchCardId}><td>{card.customer?.name || card.customer?.email || card.userId}</td><td>{card.orderId}</td><td>₹{card.eligibleOrderAmount.toLocaleString('en-IN')}</td><td>{card.rewardType === 'percentage' ? `${card.rewardValue}%` : `₹${card.rewardValue}`}</td><td>{card.rewardCode}</td><td>{card.status}</td><td>{new Date(card.createdAt).toLocaleString()}</td><td>{card.revealedAt ? new Date(card.revealedAt).toLocaleString() : 'Not scratched'}</td></tr>)}</tbody></table></div> : <AccountEmpty text="No scratch cards have been issued." />}</section>}</div>;
}

function AdminInvoicesPage() {
  const [data, setData] = useState({ invoices: [], creditNotes: [] });
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const load = async (search = '') => {
    setLoading(true);
    try { setData(await requestApi(`/api/admin/invoices${search ? `?q=${encodeURIComponent(search)}` : ''}`)); setError(''); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const search = (event) => { event.preventDefault(); load(query.trim()); };
  const download = async (invoice) => {
    try {
      await downloadInvoicePdf(`/api/admin/invoices/${encodeURIComponent(invoice.invoiceId)}/download`, invoice.invoiceNumber);
    } catch (requestError) { setError(requestError.message); }
  };
  return <div className="admin-panel-wrap admin-feature-page">
    <div className="section-title left"><span className="eyebrow">Admin · Finance</span><h2>Invoice Management</h2></div>
    {error && <div className="alert-box">{error}</div>}
    <form className="admin-invoice-search" onSubmit={search}>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Invoice number, order ID, customer email" />
      <button className="primary-btn small" disabled={loading}>Search</button>
      <button type="button" className="secondary-btn small" onClick={() => { setQuery(''); load(''); }}>Clear</button>
    </form>
    {loading ? <p className="account-loading">Loading invoices...</p> : data.invoices.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Order</th><th>Total</th><th>Payment</th><th>Date</th><th /></tr></thead><tbody>{data.invoices.map((invoice) => <tr key={invoice.invoiceId}>
      <td><strong>{invoice.invoiceNumber}</strong></td><td>{invoice.customerName}<br /><small>{invoice.customerEmail}</small></td><td>{invoice.orderId}</td>
      <td>₹{(invoice.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{invoice.paymentStatus}</td>
      <td>{new Date(invoice.createdAt).toLocaleDateString()}</td>
      <td><button className="secondary-btn small" onClick={() => setSelectedInvoice(invoice)}>Open</button> <button className="secondary-btn small" onClick={() => download(invoice)}>Download PDF</button></td>
    </tr>)}</tbody></table></div> : <AccountEmpty text="No invoices match this search." />}
    <section className="admin-panel"><div className="account-panel-heading"><h3>Credit Notes</h3><span>{data.creditNotes.length} records</span></div>{data.creditNotes.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Credit note</th><th>Invoice</th><th>Order</th><th>Refund</th><th>Amount</th><th>Date</th></tr></thead><tbody>{data.creditNotes.map((note) => <tr key={note.creditNoteNumber}><td>{note.creditNoteNumber}</td><td>{note.invoiceId}</td><td>{note.orderId}</td><td>{note.refundCaseId}</td><td>₹{(note.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{new Date(note.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div> : <p className="account-empty">Credit notes will appear when paid orders are refunded.</p>}</section>
    {selectedInvoice && <div className="wallet-lock-overlay"><section className="wallet-pin-modal admin-feature-form" role="dialog" aria-modal="true" aria-labelledby="invoice-detail-title">
      <h2 id="invoice-detail-title">{selectedInvoice.invoiceNumber}</h2>
      <p>Order #{selectedInvoice.orderId} · {new Date(selectedInvoice.createdAt).toLocaleString('en-IN')}</p>
      <p>{selectedInvoice.customerName} · {selectedInvoice.customerEmail}</p>
      <p>Payment: {selectedInvoice.paymentMethod} · {selectedInvoice.paymentStatus}</p>
      <p>Transaction: {selectedInvoice.paymentId || 'Not available'}</p>
      <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Item</th><th>Type</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>{(selectedInvoice.items || []).map((item, index) => <tr key={`${item.name}-${index}`}><td>{item.name}</td><td>{item.category || item.productType || 'Product'}</td><td>{item.quantity}</td><td>₹{Number(item.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>₹{(Number(item.price || 0) * Number(item.quantity || 1)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td></tr>)}</tbody></table></div>
      <div className="invoice-detail-totals"><div>Subtotal <strong>₹{(selectedInvoice.subtotalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>{selectedInvoice.discountAmountPaise > 0 && <div>Discount {selectedInvoice.discountCode && `(${selectedInvoice.discountCode})`} <strong>−₹{(selectedInvoice.discountAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>}{selectedInvoice.serviceChargePaise > 0 && <div>Service charges <strong>₹{(selectedInvoice.serviceChargePaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>}<div>Shipping <strong>₹{(selectedInvoice.shippingPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>{selectedInvoice.taxPaise > 0 && <div>Tax <strong>₹{(selectedInvoice.taxPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>}<div>Total paid <strong>₹{(selectedInvoice.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></div>
      <div className="modal-actions"><button type="button" className="secondary-btn" onClick={() => setSelectedInvoice(null)}>Close</button><button type="button" className="primary-btn" onClick={() => download(selectedInvoice)}>Download PDF</button></div>
    </section></div>}
  </div>;
}

function AdminWorkspaceLayout({ currentPath, children }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const sections = [
    { path: '/admin', label: 'Dashboard' },
    { path: '/admin/orders', label: 'Orders' },
    { path: '/admin/rewards', label: 'Reward Points' },
    { path: '/admin/product-reviews', label: 'Product Reviews' },
    { path: '/admin/promo-codes', label: 'Wallet Promo Codes' },
    { path: '/admin/discount-codes', label: 'Discount Promo Codes' },
    { path: '/admin/scratch-cards', label: 'Scratch Cards' },
    { path: '/admin/invoices', label: 'Invoices' },
    { path: '/admin/inventory', label: 'Inventory' },
    { path: '/admin/custom-requests', label: 'Custom Requests' },
    { path: '/admin/credit-purchases', label: 'AI Credits' },
    { path: '/admin/settings', label: 'Settings' },
    { path: '/admin/refunds', label: 'Refunds' },
  ];
  const currentSection = sections.find((section) => section.path === currentPath) || sections[0];

  return <main className="page-shell"><div className="container admin-workspace-shell">
    <header className="admin-workspace-header">
      <div><span className="eyebrow">Innovation Labs · {currentSection.label}</span><h1>Admin Dashboard</h1><p>Manage your store operations and customer experience.</p></div>
      <span className="admin-workspace-context"><span aria-hidden="true" /> Operations Workspace</span>
    </header>
    <button className="admin-mobile-nav-toggle" type="button" aria-expanded={mobileNavOpen} aria-controls="admin-primary-navigation" onClick={() => setMobileNavOpen((open) => !open)}>{mobileNavOpen ? 'Close navigation' : 'Admin navigation'}<span aria-hidden="true">{mobileNavOpen ? '×' : '☰'}</span></button>
    {mobileNavOpen && <button className="admin-mobile-nav-backdrop" type="button" aria-label="Close admin navigation" onClick={() => setMobileNavOpen(false)} />}
    <div className="admin-layout">
      <aside className={`admin-sidebar ${mobileNavOpen ? 'is-mobile-open' : ''}`}>
        <div className="admin-brand"><span className="eyebrow">Innovation Labs</span><h3>Operations</h3><p>Workspace navigation</p></div>
        <nav className="admin-nav" id="admin-primary-navigation" aria-label="Admin navigation">{sections.map((section) => <Link className={currentPath === section.path ? 'admin-nav-item active' : 'admin-nav-item'} to={section.path} key={section.path} onClick={() => setMobileNavOpen(false)}><span>{section.label}</span><span className="admin-nav-indicator" aria-hidden="true">›</span></Link>)}</nav>
      </aside>
      <div className="admin-content">{children}</div>
    </div>
  </div></main>;
}

const summarizeOrderProducts = (order) => {
  const items = Array.isArray(order?.items) ? order.items.filter((item) => item && (item.name || item.productName || item.category)) : [];
  if (!items.length) {
    return order?.orderType === 'PROMO_CODE' ? 'Promo Code' : 'No product details';
  }

  const summary = items.map((item) => `${String(item.name || item.productName || 'Item')} × ${Number(item.quantity || 1)}`);
  if (summary.length <= 2) return summary.join(', ');
  return `${summary.slice(0, 2).join(', ')} + ${summary.length - 2} more`;
};

function AdminOrdersPage({ auth }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!auth?.isAdmin) return;
    requestApi('/api/admin/orders')
      .then((result) => setOrders(result.orders || []))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [auth]);

  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading live orders...</h3></div>;

  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin</span><h2>Orders</h2></div>{error && <div className="alert-box">{error}</div>}{orders.length ? <div className="orders-list">{orders.map((order) => <div className="order-card" key={order._id}><div className="order-row"><span>Order ID</span><strong>#{order.orderId || order._id}</strong></div><div className="order-row"><span>Order Type</span><strong>{order.orderType === 'PROMO_CODE' ? 'Promo Code (Digital)' : 'Product'}</strong></div>{order.orderType !== 'PROMO_CODE' && <div className="order-row"><span>Products</span><strong>{summarizeOrderProducts(order)}</strong></div>}<div className="order-row"><span>Customer</span><strong>{order.userName}</strong></div><div className="order-row"><span>Items</span><strong>{(order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0)}</strong></div>{order.orderType === 'PROMO_CODE' && <><div className="order-row"><span>Promo Code</span><strong>{order.promoCode}</strong></div><div className="order-row"><span>Value</span><strong>₹{(Number(order.promoCodeAmountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div><div className="order-row"><span>Redemption</span><strong>{order.promoCodeStatus === 'REDEEMED' ? 'Redeemed' : 'Purchased'}</strong></div></>}<div className="order-row"><span>Total</span><strong>₹{Number(order.total || 0).toLocaleString('en-IN')}</strong></div><div className="order-row"><span>Payment</span><strong>{order.paymentMethod}</strong></div><div className="order-row"><span>Status</span><strong>{order.orderStatus}</strong></div>{order.estimatedDelivery && order.deliveryRequired !== false && <div className="order-row"><span>ETA</span><strong>{new Date(order.estimatedDelivery).toLocaleDateString()}</strong></div>}{order.orderStatus === 'Cancelled' && <span className="order-cancelled-stamp">CANCELLED</span>}{order.orderType !== 'PROMO_CODE' && order.orderStatus !== 'Cancelled' && order.orderStatus !== 'Completed' && <div className="custom-order-actions">{order.orderStatus !== 'Accepted' && <button className="primary-btn small" disabled={busyId === order._id} onClick={() => updateOrder(order._id, 'accept')}>{busyId === order._id ? 'Working...' : 'Accept'}</button>}{order.orderStatus !== 'Declined' && <button className="secondary-btn small" disabled={busyId === order._id} onClick={() => updateOrder(order._id, 'decline')}>Decline</button>}</div>}</div>)} </div> : <div className="empty-state"><h3>No active orders yet.</h3></div>}</div>;
}

function AdminOrdersPageV2({ auth }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!auth?.isAdmin) return;
    requestApi('/api/admin/orders')
      .then((result) => setOrders(result.orders || []))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [auth]);

  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading live orders...</h3></div>;

  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin</span><h2>Orders</h2></div>{error && <div className="alert-box">{error}</div>}{orders.length ? <div className="orders-list">{orders.map((order) => {
    const orderId = order.orderId || order._id;
    const orderStatus = order.orderStatus || 'Processing';
    const productSummary = summarizeOrderProducts(order);
    return <div className="order-card" key={order._id || orderId}><div className="order-row"><span>Order ID</span><strong>#{orderId}</strong></div><div className="order-row"><span>Order Type</span><strong>{order.orderType === 'PROMO_CODE' ? 'Promo Code (Digital)' : 'Product'}</strong></div>{order.orderType !== 'PROMO_CODE' && <div className="order-row"><span>Products</span><strong>{productSummary}</strong></div>}<div className="order-row"><span>Customer</span><strong>{order.userName}</strong></div><div className="order-row"><span>Items</span><strong>{(order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)}</strong></div>{order.orderType === 'PROMO_CODE' && <><div className="order-row"><span>Promo Code</span><strong>{order.promoCode || '—'}</strong></div><div className="order-row"><span>Value</span><strong>₹{(Number(order.promoCodeAmountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></>}{order.orderType !== 'PROMO_CODE' && <div className="order-row"><span>Total</span><strong>₹{Number(order.total || 0).toLocaleString('en-IN')}</strong></div>}<div className="order-row"><span>Payment</span><strong>{order.paymentMethod || 'Not set'}</strong></div><div className="order-row"><span>Status</span><strong>{orderStatus}</strong></div>{order.estimatedDelivery && order.deliveryRequired !== false && <div className="order-row"><span>ETA</span><strong>{new Date(order.estimatedDelivery).toLocaleDateString()}</strong></div>}{order.orderStatus === 'Cancelled' && <span className="order-cancelled-stamp">CANCELLED</span>}<div className="custom-order-actions"><Link className="primary-btn small" to={`/admin/orders/${encodeURIComponent(orderId)}`}>View Details</Link>{order.orderType !== 'PROMO_CODE' && ['Processing', 'Pending Review', 'Pending', 'Accepted'].includes(orderStatus) && <Link className="secondary-btn small" to={`/admin/orders/${encodeURIComponent(orderId)}`}>Manage</Link>}</div></div>;
  })}</div> : <div className="empty-state"><h3>No orders yet.</h3></div>}</div>;
}

function AdminOrderDetailPage({ auth }) {
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [estimatedDelivery, setEstimatedDelivery] = useState('');
  const [declineReason, setDeclineReason] = useState('');

  useEffect(() => {
    if (!auth?.isAdmin || !orderId) return;
    let active = true;
    requestApi(`/api/admin/orders/${encodeURIComponent(orderId)}`)
      .then((result) => {
        if (!active) return;
        const currentOrder = result.order || null;
        setOrder(currentOrder);
        if (currentOrder?.estimatedDelivery) {
          const date = new Date(currentOrder.estimatedDelivery);
          if (!Number.isNaN(date.getTime())) {
            setEstimatedDelivery(date.toISOString().slice(0, 10));
          }
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [auth, orderId]);

  const canAccept = order && order.orderType !== 'PROMO_CODE' && !['Accepted', 'Declined', 'Cancelled', 'Completed', 'Delivered'].includes(order.orderStatus || '');
  const canDecline = order && order.orderType !== 'PROMO_CODE' && ['Processing', 'Pending Review', 'Pending', 'Accepted'].includes(order.orderStatus || '');

  const submitAccept = async () => {
    if (!order || !estimatedDelivery) {
      setError('Choose an estimated delivery date before accepting this order.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await requestApi(`/api/admin/orders/${encodeURIComponent(order._id)}/accept`, {
        method: 'PATCH',
        body: JSON.stringify({ estimatedDelivery: new Date(`${estimatedDelivery}T12:00:00`).toISOString() }),
      });
      setOrder((current) => ({ ...(current || {}), ...result.order }));
      setModal(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const submitDecline = async () => {
    if (!order) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestApi(`/api/admin/orders/${encodeURIComponent(order._id)}/decline`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: declineReason || 'Order declined by admin.' }),
      });
      setOrder((current) => ({ ...(current || {}), ...result.order }));
      setModal(null);
      setDeclineReason('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading order details...</h3></div>;
  if (!order) return <div className="admin-panel-wrap"><div className="alert-box">{error || 'Order not found.'}</div><Link className="secondary-btn" to="/admin/orders">Back to Orders</Link></div>;

  const address = order.address || {};
  const productItems = Array.isArray(order.items) ? order.items : [];
  const orderStatus = order.orderStatus || 'Processing';
  const shippingAddress = [address.fullName, address.addressLine1, address.addressLine2, address.city, address.state, address.pinCode, address.country].filter(Boolean).join(', ') || 'Not provided';

  if (order.orderType === 'PROMO_CODE' && order.purchaseType === 'offline') {
    const awaitingApproval = orderStatus === 'Pending Admin Approval';
    return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin · Offline Promo Order</span><h2>{order.orderId}</h2><Link className="secondary-btn small" to="/admin/orders">← Back to Orders</Link></div>{error && <div className="alert-box" role="alert">{error}</div>}<div className="refund-admin-grid"><section className="refund-admin-panel"><h2>Order Overview</h2><dl><div><dt>Order ID</dt><dd>#{order.orderId}</dd></div><div><dt>Purchase Type</dt><dd><span className="promo-purchase-badge offline">OFFLINE PURCHASE</span></dd></div><div><dt>Status</dt><dd>{orderStatus}</dd></div><div><dt>Payment Status</dt><dd>{order.paymentStatus}</dd></div><div><dt>Payment Method</dt><dd>{order.paymentMethod}</dd></div><div><dt>Order Date</dt><dd>{new Date(order.createdAt || Date.now()).toLocaleString()}</dd></div><div><dt>Purchase Price</dt><dd>₹{Number(order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>{order.refundAmountPaise > 0 && <><div><dt>Refund Amount</dt><dd>₹{(order.refundAmountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Refund Reference</dt><dd>{order.refundTransactionReferenceId}</dd></div></>}</dl></section><section className="refund-admin-panel"><h2>Customer Information</h2><dl><div><dt>Name</dt><dd>{order.userName || 'Not provided'}</dd></div><div><dt>Email</dt><dd>{order.userEmail || 'Not provided'}</dd></div><div><dt>Phone</dt><dd>{address.phoneNumber || 'Not provided'}</dd></div></dl></section><section className="refund-admin-panel"><h2>Promo Code Product</h2><dl><div><dt>Product</dt><dd>{order.items?.[0]?.name || 'Digital Wallet Credit'}</dd></div><div><dt>Wallet Credit Value</dt><dd>₹{(Number(order.promoCodeAmountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Purchase Price</dt><dd>₹{Number(order.items?.[0]?.price || order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Quantity</dt><dd>{Number(order.items?.[0]?.quantity || 1)}</dd></div><div><dt>Promo Code</dt><dd>{order.promoCode || (orderStatus === 'Accepted' ? 'Fulfilled' : 'Withheld until acceptance')}</dd></div></dl></section><section className="refund-admin-panel"><h2>Delivery Address</h2><p>{shippingAddress}</p><p>{address.phoneNumber || ''}</p></section></div>
      {order.recipientType === 'gift' && <div className="refund-admin-grid promo-gift-admin-details"><section className="refund-admin-panel"><h2>Gift Recipient</h2><dl><div><dt>Recipient Email</dt><dd>{order.recipientEmail || 'Not provided'}</dd></div><div><dt>Recipient Name</dt><dd>{order.recipientAddress?.fullName || 'Not provided'}</dd></div><div><dt>Recipient Phone</dt><dd>{order.recipientAddress?.phoneNumber || 'Not provided'}</dd></div></dl></section><section className="refund-admin-panel"><h2>Buyer Contact Address</h2><p>{[order.buyerAddress?.fullName, order.buyerAddress?.phoneNumber, order.buyerAddress?.addressLine1, order.buyerAddress?.addressLine2, order.buyerAddress?.city, order.buyerAddress?.state, order.buyerAddress?.pinCode].filter(Boolean).join(', ') || 'Not provided'}</p></section><section className="refund-admin-panel"><h2>Recipient Delivery Address</h2><p>{[order.recipientAddress?.fullName, order.recipientAddress?.phoneNumber, order.recipientAddress?.addressLine1, order.recipientAddress?.addressLine2, order.recipientAddress?.city, order.recipientAddress?.state, order.recipientAddress?.pinCode].filter(Boolean).join(', ') || 'Not provided'}</p><p>{order.recipientAddress?.deliveryInstructions || ''}</p></section></div>}
      {order.promoMaxUses && <section className="refund-admin-panel promo-order-usage"><h2>Promo Code Usage</h2><div className="order-row"><span>Successful Uses</span><strong>{order.promoSuccessfulUses || 0} / {order.promoMaxUses}</strong></div><div className="order-row"><span>Remaining Uses</span><strong>{Math.max(0, order.promoMaxUses - (order.promoSuccessfulUses || 0))}</strong></div><div className="order-row"><span>Expiry</span><strong>{order.promoExpiresAt ? new Date(order.promoExpiresAt).toLocaleString() : 'Starts on fulfillment'}</strong></div></section>}
      {awaitingApproval && <div className="refund-admin-actions"><button className="primary-btn" disabled={busy} onClick={() => setModal('accept')}>Accept Order</button><button className="secondary-btn" disabled={busy} onClick={() => setModal('decline')}>Reject Order</button></div>}
      {modal && <div className="wallet-lock-overlay"><section className="wallet-pin-modal promo-order-action-modal" role="dialog" aria-modal="true"><h2>{modal === 'accept' ? 'Accept Offline Promo Order' : 'Reject Offline Promo Order'}</h2><p>{modal === 'accept' ? 'The reserved promo code will be activated for the customer.' : 'The order will be rejected and the paid purchase price will be credited to the customer wallet.'}</p>{modal === 'accept' ? <label>Estimated Delivery Date<input type="date" value={estimatedDelivery} onChange={(event) => setEstimatedDelivery(event.target.value)} /></label> : <label>Reason<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} placeholder="Optional reason" /></label>}<div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="primary-btn" disabled={busy || (modal === 'accept' && !estimatedDelivery)} onClick={modal === 'accept' ? submitAccept : submitDecline}>{busy ? 'Processing...' : modal === 'accept' ? 'Accept Order' : 'Reject & Refund'}</button></div></section></div>}
    </div>;
  }

  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin · Order Details</span><h2>{order.orderId || order._id}</h2><Link className="secondary-btn small" to="/admin/orders">← Back to Orders</Link></div>{error && <div className="alert-box" role="alert">{error}</div>}<div className="refund-admin-grid"><section className="refund-admin-panel"><h2>Order Overview</h2><dl><div><dt>Order ID</dt><dd>#{order.orderId || order._id}</dd></div><div><dt>Order Type</dt><dd>{order.orderType === 'PROMO_CODE' ? 'Promo Code' : 'Product'}</dd></div><div><dt>Status</dt><dd>{orderStatus}</dd></div><div><dt>Payment</dt><dd>{order.paymentMethod || 'Not set'} · {order.paymentStatus || 'Pending'}</dd></div><div><dt>Created</dt><dd>{new Date(order.createdAt || Date.now()).toLocaleString()}</dd></div>{order.estimatedDelivery && order.deliveryRequired !== false && <div><dt>Estimated Delivery</dt><dd>{new Date(order.estimatedDelivery).toLocaleDateString()}</dd></div>}{order.orderType === 'PROMO_CODE' && <div><dt>Promo Code</dt><dd>{order.promoCode || '—'}</dd></div>}</dl></section><section className="refund-admin-panel"><h2>Customer Information</h2><dl><div><dt>Name</dt><dd>{order.userName || 'Not provided'}</dd></div><div><dt>Email</dt><dd>{order.userEmail || 'Not provided'}</dd></div><div><dt>Phone</dt><dd>{address.phoneNumber || 'Not provided'}</dd></div></dl></section><section className="refund-admin-panel"><h2>Products Ordered</h2>{order.orderType === 'PROMO_CODE' ? <div className="refund-request-items"><div><span>Promo Code</span><strong>{order.promoCode || '—'}</strong></div><div><span>Value</span><strong>₹{(Number(order.promoCodeAmountPaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></div> : productItems.length ? <div className="refund-request-items">{productItems.map((item, index) => <div key={`${item.id || item.name || 'item'}-${index}`}><span>{item.name || item.productName || 'Product'} × {Number(item.quantity || 1)}</span><strong>₹{(Number(item.price || 0) * Number(item.quantity || 1)).toLocaleString('en-IN')}</strong></div>)}</div> : <p>No product details available.</p>}</section><section className="refund-admin-panel"><h2>Requirements</h2><dl><div><dt>Service</dt><dd>{order.service || 'Not requested'}</dd></div><div><dt>Project Requirements</dt><dd>{order.projectDescription || 'Not requested'}</dd></div></dl></section><section className="refund-admin-panel"><h2>Delivery Information</h2>{order.orderType === 'PROMO_CODE' ? <p>Delivery: Not required.</p> : <dl><div><dt>Delivery Address</dt><dd>{shippingAddress}</dd></div><div><dt>Estimated Delivery</dt><dd>{order.estimatedDelivery ? new Date(order.estimatedDelivery).toLocaleDateString() : 'Not assigned yet'}</dd></div></dl>}</section><section className="refund-admin-panel"><h2>Payment Information</h2><dl><div><dt>Payment Method</dt><dd>{order.paymentMethod || 'Not set'}</dd></div><div><dt>Payment Status</dt><dd>{order.paymentStatus || 'Pending'}</dd></div><div><dt>Total Paid</dt><dd>₹{Number(order.total || 0).toLocaleString('en-IN')}</dd></div></dl></section><section className="refund-admin-panel"><h2>Price Breakdown</h2><dl><div><dt>Products</dt><dd>₹{Number(order.subtotal || 0).toLocaleString('en-IN')}</dd></div>{order.codingCharge ? <div><dt>Coding</dt><dd>₹{Number(order.codingCharge || 0).toLocaleString('en-IN')}</dd></div> : null}{order.buildingCharge ? <div><dt>Building</dt><dd>₹{Number(order.buildingCharge || 0).toLocaleString('en-IN')}</dd></div> : null}{order.deliveryRequired !== false && <div><dt>Delivery</dt><dd>₹{Number(order.deliveryCharge || 0).toLocaleString('en-IN')}</dd></div>}<div><dt>Grand Total</dt><dd>₹{Number(order.total || 0).toLocaleString('en-IN')}</dd></div></dl></section><section className="refund-admin-panel"><h2>Status History</h2>{Array.isArray(order.statusHistory) && order.statusHistory.length ? <ul className="refund-timeline">{order.statusHistory.map((entry, index) => <li key={`${entry.status}-${index}`}><strong>{entry.status}</strong><span>{new Date(entry.createdAt || Date.now()).toLocaleString()}</span><p>{entry.note || 'No note provided.'}</p></li>)}</ul> : <p>No status history available.</p>}</section></div><div className="refund-admin-actions">{canAccept && <button className="primary-btn" disabled={busy} onClick={() => setModal('accept')}>Accept</button>}{canDecline && <button className="secondary-btn" disabled={busy} onClick={() => setModal('decline')}>Decline</button>}</div>{modal && <div className="wallet-lock-overlay"><section className="wallet-pin-modal" role="dialog" aria-modal="true"><h2>{modal === 'accept' ? 'Accept Order?' : 'Decline Order?'}</h2>{modal === 'accept' ? <><p>Are you sure you want to accept this order?</p><label>Estimated Delivery Date<input type="date" value={estimatedDelivery} onChange={(event) => setEstimatedDelivery(event.target.value)} /></label></> : <><p>Are you sure you want to decline this order?</p><label>Reason<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} rows="4" placeholder="Optional reason" /></label></>}{modal === 'accept' && !estimatedDelivery && <p className="voice-error" role="alert">Choose a delivery date first.</p>}<div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="primary-btn" disabled={busy || (modal === 'accept' && !estimatedDelivery)} onClick={modal === 'accept' ? submitAccept : submitDecline}>{busy ? 'Processing...' : modal === 'accept' ? 'Confirm Acceptance' : 'Confirm Decline'}</button></div></section></div>}</div>;
}

function InventoryPage({ auth }) {
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ productId: '', name: '', category: 'Other Components', pricePaise: '0', stock: '0', description: '', images: '', technicalSpecs: '{}' });
  const [saving, setSaving] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [editStock, setEditStock] = useState('');
  const [editError, setEditError] = useState('');
  const [savingStock, setSavingStock] = useState(false);

  useEffect(() => {
    if (!auth?.isAdmin) return;
    requestApi('/api/admin/inventory')
      .then((result) => setInventory(result.inventory || []))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [auth]);

  const saveInventoryItem = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      let technicalSpecs;
      try {
        technicalSpecs = JSON.parse(form.technicalSpecs || '{}');
      } catch {
        throw new Error('Technical specifications must be valid JSON.');
      }
      if (!technicalSpecs || Array.isArray(technicalSpecs) || typeof technicalSpecs !== 'object') {
        throw new Error('Technical specifications must be a JSON object.');
      }
      const result = await requestApi('/api/admin/inventory', {
        method: 'POST',
        body: JSON.stringify({
          productId: form.productId,
          name: form.name,
          category: form.category,
          pricePaise: Number(form.pricePaise || 0),
          stock: Number(form.stock || 0),
          description: form.description,
          images: form.images.split(/\r?\n/).map((image) => image.trim()).filter(Boolean),
          technicalSpecs,
        }),
      });
      setInventory((current) => [result.inventoryItem, ...current.filter((item) => item.productId !== result.inventoryItem.productId)]);
      setForm({ productId: '', name: '', category: 'Other Components', pricePaise: '0', stock: '0', description: '', images: '', technicalSpecs: '{}' });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const saveStockEdit = async (event) => {
    event.preventDefault();
    if (!/^\d+$/.test(editStock) || !Number.isSafeInteger(Number(editStock))) {
      setEditError('Stock must be a non-negative whole number.');
      return;
    }
    setSavingStock(true);
    setEditError('');
    try {
      const result = await requestApi(`/api/admin/inventory/${encodeURIComponent(editingItem.productId)}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ stock: Number(editStock) }),
      });
      setInventory((current) => current.map((item) => item.productId === result.inventoryItem.productId ? result.inventoryItem : item));
      setEditingItem(null);
    } catch (requestError) {
      setEditError(requestError.message);
    } finally {
      setSavingStock(false);
    }
  };

  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading stock data...</h3></div>;

  return (
    <div className="admin-panel-wrap">
      <div className="section-title left"><span className="eyebrow">Admin</span><h2>Inventory</h2></div>
      {error && <div className="alert-box">{error}</div>}
      <form className="admin-form" onSubmit={saveInventoryItem}>
        <div className="admin-form-grid">
          <label>Product ID<input value={form.productId} onChange={(event) => setForm((current) => ({ ...current, productId: event.target.value }))} placeholder="arduino-uno" required /></label>
          <label>Name<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Arduino Uno" required /></label>
          <label>Category<input value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} placeholder="Sensors, Displays, Motors..." maxLength={80} /></label>
          <label>Price (₹ × 100 or paise)<input type="number" min="0" step="1" value={form.pricePaise} onChange={(event) => setForm((current) => ({ ...current, pricePaise: event.target.value }))} required /></label>
          <label>Stock<input type="number" min="0" step="1" value={form.stock} onChange={(event) => setForm((current) => ({ ...current, stock: event.target.value }))} required /></label>
        </div>
        <label>Description<textarea rows="3" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Inventory notes" /></label>
        <label>Product images (one URL per line, up to 8)<textarea rows="3" value={form.images} onChange={(event) => setForm((current) => ({ ...current, images: event.target.value }))} placeholder="https://example.com/product-front.jpg" /></label>
        <label>Technical specifications (JSON object)<textarea rows="3" value={form.technicalSpecs} onChange={(event) => setForm((current) => ({ ...current, technicalSpecs: event.target.value }))} placeholder={'{"Voltage":"5V","Interface":"I2C"}'} /></label>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving...' : 'Save Inventory Item'}</button>
      </form>
      {inventory.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>{inventory.map((item) => <tr key={item._id}><td><strong>{item.name}</strong><br /><small>{item.productId}</small></td><td>{item.category || 'Other Components'}</td><td>₹{(Number(item.pricePaise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{item.stock}</td><td><span className={`status-pill status-${String(item.status).toLowerCase().replace(/\s+/g, '-')}`}>{item.status}</span></td><td><button className="secondary-btn small" type="button" onClick={() => { setEditingItem(item); setEditStock(String(item.stock)); setEditError(''); }}>Edit</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><h3>No inventory entries yet.</h3></div>}
      {editingItem && <Modal onClose={() => setEditingItem(null)}><form className="modal-content inventory-edit-form" onSubmit={saveStockEdit}><span className="eyebrow">Edit Inventory</span><h3>{editingItem.name}</h3><p>{editingItem.productId}</p><p>Current stock: <strong>{editingItem.stock}</strong></p><label>New stock<input type="number" min="0" step="1" value={editStock} onChange={(event) => setEditStock(event.target.value)} required autoFocus /></label>{editError && <div className="alert-box" role="alert">{editError}</div>}<div className="modal-actions"><button className="secondary-btn" type="button" onClick={() => setEditingItem(null)}>Cancel</button><button className="primary-btn" disabled={savingStock}>{savingStock ? 'Saving...' : 'Save Changes'}</button></div></form></Modal>}
    </div>
  );
}

function AdminSettingsPage({ auth }) {
  const [settings, setSettings] = useState({ maxActiveOrders: 50 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!auth?.isAdmin) return;
    requestApi('/api/admin/settings')
      .then((result) => setSettings(result.settings || { maxActiveOrders: 50 }))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [auth]);

  const updateLimit = async () => {
    setSaving(true);
    try {
      const result = await requestApi('/api/admin/settings/max-active-orders', { method: 'PATCH', body: JSON.stringify({ value: Number(settings.maxActiveOrders) }) });
      setSettings(result.settings || settings);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading settings...</h3></div>;

  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin</span><h2>Operational Settings</h2></div>{error && <div className="alert-box">{error}</div>}<div className="account-card"><div className="order-row"><span>Max active orders</span><strong>{settings.maxActiveOrders}</strong></div><label className="wallet-amount">Order capacity<input type="number" min="1" value={settings.maxActiveOrders} onChange={(event) => setSettings((current) => ({ ...current, maxActiveOrders: event.target.value }))} /></label><button className="primary-btn" disabled={saving} onClick={updateLimit}>{saving ? 'Saving...' : 'Update limit'}</button></div></div>;
}

function AdminCreditPurchasesPage({ auth }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!auth?.isAdmin) return;
    requestApi('/api/admin/credit-purchases')
      .then((result) => setPurchases(result.purchases || []))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [auth]);
  if (!auth?.isAdmin) return <div className="empty-state"><h3>Admin access is required.</h3></div>;
  if (loading) return <div className="empty-state"><h3>Loading credit purchases...</h3></div>;
  return <div className="admin-panel-wrap"><div className="section-title left"><span className="eyebrow">Admin</span><h2>AI Credit Purchases</h2></div>{error && <div className="alert-box">{error}</div>}{purchases.length ? <div className="inventory-table-wrap"><table className="promo-table"><thead><tr><th>Customer</th><th>Transaction</th><th>Credits</th><th>Amount</th><th>Payment</th><th>Status</th><th>Date</th></tr></thead><tbody>{purchases.map((purchase) => <tr key={purchase.purchaseId}><td><strong>{purchase.user.name || purchase.user.email}</strong><br /><small>{purchase.user.email || purchase.user.id}</small></td><td>{purchase.purchaseId}</td><td>{purchase.credits.toLocaleString('en-IN')}</td><td>₹{purchase.totalAmount.toLocaleString('en-IN')}</td><td>{purchase.paymentMethod}</td><td>{purchase.status}</td><td>{new Date(purchase.completedAt || purchase.createdAt || Date.now()).toLocaleString()}</td></tr>)}</tbody></table></div> : <div className="empty-state"><h3>No credit purchases yet.</h3></div>}</div>;
}

function AdminPromoCodesPage({ auth }) {
  const [promoCodes, setPromoCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [validityDays, setValidityDays] = useState('30');
  const [validityHours, setValidityHours] = useState('0');
  const [validityMinutes, setValidityMinutes] = useState('0');
  const [maxUses, setMaxUses] = useState('10');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!auth?.isAdmin) { setLoading(false); return; }
    requestApi('/api/admin/promo-codes')
      .then((result) => setPromoCodes((result.promoCodes || []).map((promo) => ({ ...promo, maxUses: promo.maxUses ?? (promo.status === 'used' ? 1 : 10), successfulUses: promo.successfulUses ?? (promo.status === 'used' ? 1 : 0), validitySeconds: promo.validitySeconds ?? 30 * 24 * 60 * 60 }))))
      .catch(() => setPageError('Unable to load promo codes right now.'))
      .finally(() => setLoading(false));
  }, [auth]);

  if (!auth?.isAdmin) return <main className="page-shell"><div className="container centered-box"><div className="empty-state"><h3>Admin access is required.</h3></div></div></main>;

  const savePromoCode = async (event) => {
    event.preventDefault();
    const amountPaise = Math.round(Number(amount) * 100);
    if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)) {
      setFeedback({ title: 'Invalid Promo Code', message: 'Use exactly XXXX-XXXX-XXXX-XXXX with uppercase letters or numbers.' });
      return;
    }
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      setFeedback({ title: 'Invalid Amount', message: 'Enter an amount greater than ₹0.' });
      return;
    }
    setSaving(true);
    try {
      const result = await requestApi('/api/admin/promo-codes', { method: 'POST', body: JSON.stringify({ code, amountPaise, validityDays: Number(validityDays), validityHours: Number(validityHours), validityMinutes: Number(validityMinutes), maxUses: Number(maxUses) }) });
      setPromoCodes((current) => [result.promoCode, ...current]);
      setModalOpen(false);
      setCode('');
      setAmount('');
      setValidityDays('30');
      setValidityHours('0');
      setValidityMinutes('0');
      setMaxUses('10');
      setFeedback({ title: 'Promo Code Created Successfully', message: `${result.promoCode.code} is now available in the customer Promo Codes marketplace.` });
    } catch (error) {
      setFeedback(error.message.includes('already exists')
        ? { title: 'Promo Code Already Exists', message: 'Please enter a different promo code.' }
        : { title: 'Unable to Save Promo Code', message: error.message });
    } finally {
      setSaving(false);
    }
  };

  const deactivatePromoCode = async (promo) => {
    try {
      const result = await requestApi(`/api/admin/promo-codes/${promo._id}/deactivate`, { method: 'PATCH' });
      setPromoCodes((current) => current.map((item) => item._id === promo._id ? result.promoCode : item));
    } catch (error) { setPageError(error.message); }
  };

  return <main className="page-shell"><div className="container"><div className="section-title left promo-admin-heading"><div><span className="eyebrow">Admin · Wallet Credits</span><h2>Wallet Promo Codes</h2></div><button className="primary-btn" onClick={() => setModalOpen(true)}>Add Wallet Promo Code</button></div>
    {pageError && <div className="alert-box" role="alert">{pageError}</div>}
    {loading ? <div className="empty-state"><h3>Loading promo codes...</h3></div> : promoCodes.length ? <div className="promo-table-wrap"><table className="promo-table"><thead><tr><th>Promo Code</th><th>Value</th><th>Validity</th><th>Uses</th><th>Status</th><th>Owner</th><th>Activation / Expiry</th><th>Actions</th></tr></thead><tbody>{promoCodes.map((promo) => <tr key={promo._id}><td><strong>{promo.code}</strong></td><td>₹{(promo.amount ?? promo.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td><td>{Math.floor((promo.validitySeconds || 0) / 86400)}d {Math.floor(((promo.validitySeconds || 0) % 86400) / 3600)}h {Math.floor(((promo.validitySeconds || 0) % 3600) / 60)}m</td><td>{promo.successfulUses || 0} / {promo.maxUses || 1}<br /><small>{Math.max(0, (promo.maxUses || 1) - (promo.successfulUses || 0))} remaining</small></td><td><span className={`status-pill status-${promo.status}`}>{promo.status}</span></td><td>{promo.usedBy?.email || promo.purchasedBy?.email || promo.giftRecipientEmail || '—'}</td><td>{promo.activatedAt ? `${new Date(promo.activatedAt).toLocaleString()} → ${promo.expiresAt ? new Date(promo.expiresAt).toLocaleString() : 'No expiry'}` : 'Not activated'}</td><td>{promo.status === 'unused' ? <button className="secondary-btn small" onClick={() => deactivatePromoCode(promo)}>Deactivate</button> : '—'}</td></tr>)}</tbody></table></div> : <div className="empty-state"><h3>No promo codes yet.</h3></div>}
    {modalOpen && <div className="wallet-lock-overlay"><form className="wallet-pin-modal account-form promo-create-modal" onSubmit={savePromoCode}><h2>Add Promo Code</h2><label>Promo Code<input autoFocus value={code} onChange={(event) => setCode(formatPromoCode(event.target.value))} placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={19} /></label><label>Wallet Credit Amount (₹)<input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" /></label><div className="promo-validity-fields"><label>Validity Days<input type="number" min="0" step="1" value={validityDays} onChange={(event) => setValidityDays(event.target.value)} /></label><label>Hours<input type="number" min="0" max="23" step="1" value={validityHours} onChange={(event) => setValidityHours(event.target.value)} /></label><label>Minutes<input type="number" min="0" max="59" step="1" value={validityMinutes} onChange={(event) => setValidityMinutes(event.target.value)} /></label></div><label>Maximum Successful Uses<input type="number" min="1" max="1000" step="1" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} /></label><div className="modal-actions"><button type="button" className="secondary-btn" disabled={saving} onClick={() => setModalOpen(false)}>Cancel</button><button className="primary-btn" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></div></form></div>}
    {feedback && <div className="wallet-lock-overlay"><div className="wallet-pin-modal"><h2>{feedback.title}</h2><p>{feedback.message}</p><button className="primary-btn full" onClick={() => setFeedback(null)}>OK</button></div></div>}
  </div></main>;
}

function PromoExpiryCountdown({ expiresAt, status }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!expiresAt) return <span>No expiry recorded</span>;
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  if (remaining === 0 || status === 'expired') return <span className="promo-code-state expired">EXPIRED</span>;
  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  return <span>{days} Days : {String(hours).padStart(2, '0')} Hours : {String(minutes).padStart(2, '0')} Minutes : {String(restSeconds).padStart(2, '0')} Seconds</span>;
}

function PromoOrderAccountDetails({ order }) {
  const redemptionStatus = order.promoCodeStatus === 'REDEEMED' || order.promoCodeStatus === 'FULLY_REDEEMED'
    ? 'Fully Redeemed'
    : order.promoCodeStatus === 'PARTIALLY_REDEEMED' ? 'Partially Redeemed' : 'Not Redeemed';
  return <>
    <div className="order-row"><span>Recipient</span><strong>{order.recipientType === 'gift' ? 'Gift Purchase' : 'For Myself'}</strong></div>
    {order.recipientType === 'gift' && order.recipientEmail && <div className="order-row"><span>Recipient Email</span><strong>{order.recipientEmail}</strong></div>}
    {order.promoActivationStatus && <div className="order-row"><span>Activation Status</span><strong>{order.promoActivationStatus.replace('_', ' ')}</strong></div>}
    {order.promoCodeStatus && <div className="order-row"><span>Redemption Status</span><strong>{order.purchaseType === 'offline' && !order.promoCode ? 'Hidden until fulfillment' : redemptionStatus}</strong></div>}
    {order.promoMaxUses && <div className="order-row"><span>Successful Uses</span><strong>{order.promoSuccessfulUses || 0} / {order.promoMaxUses} · {Math.max(0, order.promoMaxUses - (order.promoSuccessfulUses || 0))} remaining</strong></div>}
    {order.promoExpiresAt && order.promoActivationStatus !== 'pending' && <div className="order-row"><span>Time Remaining</span><strong><PromoExpiryCountdown expiresAt={order.promoExpiresAt} status={order.promoActivationStatus} /></strong></div>}
  </>;
}

function AccountOrderRow({ order, dateFor, itemCountFor }) {
  return (
    <div className="recent-order-row">
      <span className="recent-order-mark" aria-hidden="true">↗</span>
      <div><strong>#{order.id}</strong><span>{dateFor(order.date)} · {itemCountFor(order)} items</span></div>
      <strong>₹{order.total}</strong>
    </div>
  );
}

function OrdersPage({ orders, auth, loading, error, onSignIn, onCancelOrder }) {
  if (!auth) {
    return (
      <main className="page-shell">
        <div className="container centered-box">
          <div className="empty-state">
            <h3>Please sign in to view your orders.</h3>
            <button className="primary-btn" onClick={onSignIn}>Sign In</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <div className="container">
        <div className="section-title left">
          <span className="eyebrow">Order history</span>
          <h2>My Orders</h2>
        </div>

        {loading ? <div className="empty-state"><h3>Loading your orders...</h3></div> : error ? (
          <div className="alert-box" role="alert">{error}</div>
        ) : orders.filter((order) => order.email === auth.email).length === 0 ? (
          <div className="empty-state">
            <h3>No orders yet.</h3>
          </div>
        ) : (
          <div className="orders-list">
            {orders.filter((order) => order.email === auth.email).map((order) => (
              <div key={order.id} className="order-card">
                <div className="order-row"><span>Order ID</span><strong>{order.id}</strong></div>
                <div className="order-row"><span>Date</span><strong>{new Date(order.date).toLocaleDateString()}</strong></div>
                <div className="order-row"><span>Items</span><strong>{order.items.reduce((sum, item) => sum + item.quantity, 0)}</strong></div>
                {order.orderType === 'PROMO_CODE' && <div className="order-row"><span>Purchase Type</span><strong><span className={`promo-purchase-badge ${order.purchaseType || 'online'}`}>{order.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</span></strong></div>}
                {order.orderType === 'PROMO_CODE' && <PromoOrderAccountDetails order={order} />}
                <div className="order-row"><span>Amount</span><strong>₹{order.total}</strong></div>
                {order.orderType === 'PROMO_CODE' && order.purchaseType === 'offline' && !order.promoCode && <div className="order-row"><span>Promo Code</span><strong>Hidden until fulfillment</strong></div>}
                {order.orderType === 'PROMO_CODE' && order.promoCode && <div className="order-row"><span>Promo Code</span><strong>{order.promoCode}</strong></div>}
                {order.orderType === 'PROMO_CODE' && order.promoCodeStatus && <div className="order-row"><span>Redemption</span><strong>{order.promoCodeStatus === 'REDEEMED' ? 'Redeemed' : order.purchaseType === 'offline' && !order.promoCode ? 'Hidden until fulfillment' : 'Ready to redeem'}</strong></div>}
                {order.orderType === 'PROMO_CODE' && order.purchaseType === 'offline' && order.orderStatus === 'Pending Admin Approval' && <div className="order-row"><span>Fulfillment</span><strong>Pending admin approval</strong></div>}
                <div className="order-row"><span>Payment</span><strong>{order.paymentStatus}</strong></div>
                <div className="order-row"><span>Status</span><strong>{order.orderStatus}</strong></div>
                {['Declined', 'Rejected'].includes(order.orderStatus) && order.refundCase && <><div className="order-row"><span>Refund Status</span><strong>{refundStatusLabel(order.refundCase.status)}</strong></div><div className="order-row"><span>Refund Amount</span><strong>₹{((order.refundCase.approvedRefundAmountPaise ?? order.refundCase.refundAmountPaise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div></>}
                <div className="order-actions"><Link to="/order-placed" state={{ order }} className="primary-btn small">View Details</Link>{order.refundEligible && !order.cancelEligible && <Link className="secondary-btn small" to={`/refund/${encodeURIComponent(order.id)}`}>Refund</Link>}{order.cancelEligible && !order.refundEligible && <button className="secondary-btn small" onClick={() => onCancelOrder(order)}>Cancel</button>}</div>
                {(order.cancellationId || order.orderStatus === 'Cancelled' || order.refundCase) && <div className="order-status-stamps">{(order.cancellationId || order.orderStatus === 'Cancelled') && <span className="order-cancelled-stamp">CANCELLED</span>}{order.refundCase && <span className="refund-order-stamp">{refundStatusLabel(order.refundCase.status).toUpperCase()}</span>}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CustomOrdersPage({ auth, customOrders, notifications, error, itemName, submitting, setItemName, onSubmit, onOrder }) {
  const [activeTab, setActiveTab] = useState('make');
  const [dismissedOrders, setDismissedOrders] = useState([]);
  const pendingOrders = customOrders.filter((order) => !['Accepted', 'Ordered'].includes(order.status));
  const acceptedOrders = customOrders.filter((order) =>
    order.status === 'Accepted' && !dismissedOrders.includes(order._id)
  );

  if (!auth) {
    return (
      <main className="page-shell">
        <div className="container centered-box">
          <div className="empty-state">
            <h3>Sign in to request a custom part.</h3>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <div className="container">
        <div className="section-title left">
          <span className="eyebrow">Parts beyond the catalog</span>
          <h2>Custom Order</h2>
        </div>

        <div className="custom-tabs" role="tablist" aria-label="Custom order views">
          <button type="button" role="tab" aria-selected={activeTab === 'make'} className={activeTab === 'make' ? 'selected' : ''} onClick={() => setActiveTab('make')}>
            Make Custom Order
          </button>
          <button type="button" role="tab" aria-selected={activeTab === 'accepted'} className={activeTab === 'accepted' ? 'selected' : ''} onClick={() => setActiveTab('accepted')}>
            Accepted Orders
          </button>
        </div>

        {error && <div className="alert-box" role="alert">{error}</div>}

        {notifications.length > 0 && (
          <section className="notification-list" aria-label="Notifications">
            {notifications.map((notification) => (
              <p key={notification._id}>{notification.message}</p>
            ))}
          </section>
        )}

        {activeTab === 'make' ? (
          <>
            <form className="custom-form" onSubmit={onSubmit}>
              <label htmlFor="custom-item-name">Enter the name of the item you want.</label>
              <input
                id="custom-item-name"
                value={itemName}
                onChange={(event) => setItemName(event.target.value)}
                placeholder="Enter item name"
                maxLength={120}
                required
              />
              <button className="primary-btn" type="submit" disabled={!itemName.trim() || submitting}>
                {submitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </form>

            <div className="custom-order-grid">
              {pendingOrders.length === 0 ? (
                <div className="empty-state"><h3>No custom requests yet.</h3></div>
              ) : pendingOrders.map((order) => (
                <article className="custom-order-card" key={order._id}>
                  <h3>{order.requestedItem}</h3>
                  <div className="order-row"><span>Status</span><strong>{order.status}</strong></div>
                  <div className="order-row"><span>Requested</span><strong>{new Date(order.createdAt).toLocaleDateString()}</strong></div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="custom-order-grid">
            {acceptedOrders.length === 0 ? (
              <div className="empty-state"><h3>No accepted custom orders yet.</h3></div>
            ) : acceptedOrders.map((order) => (
              <article className="custom-order-card" key={order._id}>
                <h3>Custom Item: {order.requestedItem}</h3>
                <div className="order-row"><span>Status</span><strong>Accepted</strong></div>
                <div className="order-row"><span>Price</span><strong>₹{order.price}</strong></div>
                <p>Do you want to order this item?</p>
                <div className="custom-order-actions">
                  <button className="primary-btn small" onClick={() => onOrder(order)}>Yes, Order</button>
                  <button className="secondary-btn small" onClick={() => setDismissedOrders((current) => [...current, order._id])}>No</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function AdminCustomRequestsPage({ auth, customOrders, error, prices, setPrices, onAccept, onReject }) {
  if (!auth?.isAdmin) {
    return (
      <main className="page-shell">
        <div className="container centered-box">
          <div className="empty-state"><h3>Admin access is required.</h3></div>
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <div className="container">
        <div className="section-title left">
          <span className="eyebrow">Admin</span>
          <h2>Custom Requests</h2>
        </div>
        {error && <div className="alert-box" role="alert">{error}</div>}
        {customOrders.length === 0 ? (
          <div className="empty-state"><h3>No custom-part requests.</h3></div>
        ) : (
          <div className="custom-order-grid">
            {customOrders.map((order) => (
              <article className="custom-order-card" key={order._id}>
                <h3>Requested Item: {order.requestedItem}</h3>
                <div className="order-row"><span>Customer</span><strong>{order.userName}</strong></div>
                <div className="order-row"><span>Email</span><a href={`mailto:${order.userEmail}`}>{order.userEmail}</a></div>
                <div className="order-row"><span>Request date</span><strong>{new Date(order.createdAt).toLocaleString()}</strong></div>
                <div className="order-row"><span>Status</span><strong>{order.status}</strong></div>
                {order.status === 'Pending' && (
                  <>
                    <label className="request-price">
                      Price (₹)
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={prices[order._id] ?? ''}
                        onChange={(event) => setPrices((current) => ({ ...current, [order._id]: event.target.value }))}
                        required
                      />
                    </label>
                    <div className="custom-order-actions">
                      <button className="primary-btn small" disabled={!Number(prices[order._id])} onClick={() => onAccept(order)}>Accept</button>
                      <button className="secondary-btn small" onClick={() => onReject(order)}>Reject</button>
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function OrderPlacedPage({ order }) {
  const [stage, setStage] = useState(0);
  const [copyState, setCopyState] = useState('Copy Code');
  const [discountRevealOpen, setDiscountRevealOpen] = useState(false);
  const orderKey = order?.orderId || order?.id;
  const address = order?.address || {};
  const packageLabels = { parts: 'Parts Only', coding: 'Parts + Coding', building: 'Parts + Building', full: 'Complete Build' };
  const money = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isPromoCodeOrder = order?.orderType === 'PROMO_CODE';
  const promoCodeValue = order?.promoCode || order?.items?.find((item) => item.category === 'Promo Code')?.promoCode || '';
  const promoValuePaise = order?.promoCodeAmountPaise ?? (order?.items?.find((item) => item.category === 'Promo Code') ? Math.round(order.items.find((item) => item.category === 'Promo Code').price * 100) : 0);
  const orderDate = order?.date || order?.createdAt;
  const isGiftOrder = order?.recipientType === 'gift';
  const purchasedDiscountCodes = Array.isArray(order?.discountCodes) ? order.discountCodes : [];
  const canCopyPromoCode = Boolean(promoCodeValue && isPromoCodeOrder && order?.purchaseType !== 'offline');
  const copyPromoCode = async () => {
    if (!promoCodeValue) return;
    try {
      await navigator.clipboard.writeText(promoCodeValue);
      setCopyState('Copied!');
      window.setTimeout(() => setCopyState('Copy Code'), 1800);
    } catch {
      setCopyState('Copy unavailable');
      window.setTimeout(() => setCopyState('Copy Code'), 1800);
    }
  };
  const deliveryDate = order?.estimatedDelivery
    ? Number.isNaN(new Date(order.estimatedDelivery).getTime()) ? order.estimatedDelivery : new Date(order.estimatedDelivery).toLocaleDateString()
    : 'Pending admin confirmation';
  const addressLines = [
    address.addressLine1,
    address.addressLine2,
    [address.city, address.state, address.pinCode].filter(Boolean).join(', '),
    address.country,
  ].filter(Boolean);
  const maskedPhone = address.phoneNumber ? String(address.phoneNumber).replace(/\d(?=\d{2})/g, '*') : '';

  useEffect(() => {
    if (!orderKey) return undefined;
    setStage(0);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const stageTimes = reducedMotion
      ? [500, 620, 740, 860, 980, 1100, 1220, 1340]
      : [1300, 1850, 2200, 2520, 2790, 3060, 3330, 3600];
    const timers = stageTimes.map((delay, index) => setTimeout(() => setStage(index + 1), delay));
    return () => timers.forEach(clearTimeout);
  }, [orderKey]);

  useEffect(() => {
    setDiscountRevealOpen(false);
  }, [orderKey]);

  useEffect(() => {
    if (stage >= 2 && purchasedDiscountCodes.length) setDiscountRevealOpen(true);
  }, [stage, orderKey, purchasedDiscountCodes.length]);

  const copyDiscountCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('Copied!');
      window.setTimeout(() => setCopyState('Copy Code'), 1800);
    } catch {
      setCopyState('Copy unavailable');
      window.setTimeout(() => setCopyState('Copy Code'), 1800);
    }
  };

  if (!order) {
    return <main className="page-shell"><div className="container centered-box"><h2>No order found.</h2></div></main>;
  }

  return (
    <>
    <main className="page-shell order-confirmation-shell">
      <div className="container order-confirmation-container">
        {stage === 0 ? <div className="order-processing" role="status" aria-live="polite"><span className="order-buffer-spinner" aria-hidden="true" /><p>Processing Order</p></div> : <>
          <header className="order-confirmation-header">
            <div className={`order-success-circle ${stage >= 1 ? 'is-visible' : ''}`} role="img" aria-label="Order successfully placed"><span className="order-checkmark" aria-hidden="true" /></div>
            {stage >= 2 && <><h1 className="order-confirmation-title">{order.orderStatus === 'Declined' ? 'Order Declined' : order.orderStatus === 'Rejected' ? 'Order Rejected' : isGiftOrder ? 'Gift Order Confirmed' : 'Order Placed'}</h1><p className="order-confirmation-intro">{order.orderStatus === 'Declined' ? 'Your order was declined by the admin. The refundable parts amount has been credited to your wallet.' : order.orderStatus === 'Rejected' ? 'Your offline Promo Code order was rejected. The eligible purchase amount was refunded to your wallet.' : order.orderType === 'PROMO_CODE' && order.purchaseType === 'offline' && order.orderStatus === 'Pending Admin Approval' ? 'Your payment is confirmed. This offline order is pending admin approval; the Promo Code and wallet credit will be activated only after acceptance.' : isGiftOrder ? 'Your gift order was successfully placed. The promo code is assigned to the recipient account.' : isPromoCodeOrder ? 'Your digital Promo Code purchase has been confirmed. The code is ready to redeem in your Wallet.' : 'Your order has been successfully placed. Our team will review your order and update the delivery timeline.'}</p></>}
          </header>

          {stage >= 3 && !isPromoCodeOrder && order.deliveryRequired !== false && <section className="order-confirmation-card order-address-card" aria-labelledby="delivery-address-title">
            <h2 id="delivery-address-title">Delivery Address</h2>
            <strong className="order-recipient-name">{address.fullName || order.customerName || 'Customer'}</strong>
            {maskedPhone && <p className="order-recipient-phone">Phone: {maskedPhone}</p>}
            <address>{addressLines.length ? addressLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>) : <span>Address not available</span>}</address>
          </section>}

          {stage >= 3 && isPromoCodeOrder && <section className="order-confirmation-card order-address-card promo-order-code-card" aria-labelledby="order-promo-code-title"><h2 id="order-promo-code-title">Promo Code Order</h2><dl className="order-information-list"><div><dt>Purchase Type</dt><dd>{order.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</dd></div><div><dt>Recipient Type</dt><dd>{isGiftOrder ? 'Gift Purchase' : 'For Myself'}</dd></div>{isGiftOrder && <><div><dt>Buyer</dt><dd>{order.userName || order.customerName} · {order.userEmail || order.email}</dd></div><div><dt>Recipient Email</dt><dd>{order.recipientEmail || 'Recipient at delivery address'}</dd></div></>}<div><dt>Wallet Value</dt><dd>₹{money(promoValuePaise / 100)}</dd></div><div><dt>Order Status</dt><dd>{order.orderStatus}</dd></div><div><dt>Activation Status</dt><dd>{order.promoActivationStatus || 'Pending admin approval'}</dd></div>{order.promoExpiresAt && <div><dt>Time Remaining</dt><dd><PromoExpiryCountdown expiresAt={order.promoExpiresAt} status={order.promoActivationStatus} /></dd></div>}{order.promoCode ? <><div><dt>Promo Code</dt><dd><code>{promoCodeValue}</code>{canCopyPromoCode && <button type="button" className="secondary-btn small copy-code-button" onClick={copyPromoCode} style={{ marginTop: '0.5rem' }}>{copyState}</button>}</dd></div><div><dt>Redemption Status</dt><dd>{order.promoCodeStatus === 'FULLY_REDEEMED' || order.promoCodeStatus === 'REDEEMED' ? 'Fully Redeemed' : order.promoCodeStatus === 'PARTIALLY_REDEEMED' ? 'Partially Redeemed' : 'Not Redeemed'}</dd></div></> : <div><dt>Promo Code</dt><dd>{order.purchaseType === 'offline' ? 'Hidden until fulfillment' : order.orderStatus === 'Rejected' ? 'Not issued; order rejected' : 'Available to its assigned account after activation'}</dd></div>}</dl></section>}
          {stage >= 3 && isPromoCodeOrder && order.purchaseType === 'offline' && order.orderStatus !== 'Rejected' && <section className="order-confirmation-card order-address-card" aria-labelledby="promo-delivery-address-title"><h2 id="promo-delivery-address-title">Delivery Address</h2><strong>{address.fullName || order.customerName || 'Customer'}</strong><address>{[address.addressLine1, address.addressLine2, [address.city, address.state, address.pinCode].filter(Boolean).join(', '), address.country].filter(Boolean).map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</address><p>{address.phoneNumber}</p></section>}
          {stage >= 3 && isPromoCodeOrder && order.purchaseType === 'offline' && order.orderStatus !== 'Rejected' && isGiftOrder && order.buyerAddress && <section className="order-confirmation-card order-address-card" aria-labelledby="promo-buyer-address-title"><h2 id="promo-buyer-address-title">Buyer Contact Address</h2><address>{[order.buyerAddress.fullName, order.buyerAddress.phoneNumber, order.buyerAddress.addressLine1, order.buyerAddress.addressLine2, [order.buyerAddress.city, order.buyerAddress.state, order.buyerAddress.pinCode].filter(Boolean).join(', ')].filter(Boolean).map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</address></section>}

          {stage >= 4 && <section className="order-confirmation-card order-staged-card" aria-labelledby="order-information-title">
            <h2 id="order-information-title">Order Information</h2>
            <dl className="order-information-list">
              <div><dt>Order ID</dt><dd>{order.orderId || order.id || 'Not available'}</dd></div>
              {isPromoCodeOrder && <div><dt>Order Type</dt><dd>Promo Code</dd></div>}
              {isPromoCodeOrder && <div><dt>Purchase Type</dt><dd>{order.purchaseType === 'offline' ? 'OFFLINE PURCHASE' : 'ONLINE PURCHASE'}</dd></div>}
              {isPromoCodeOrder && order.promoMaxUses && <div><dt>Successful Uses</dt><dd>{order.promoSuccessfulUses || 0} / {order.promoMaxUses} · {Math.max(0, order.promoMaxUses - (order.promoSuccessfulUses || 0))} remaining</dd></div>}
              {isPromoCodeOrder && <div><dt>Recipient Type</dt><dd>{isGiftOrder ? 'Gift Purchase' : 'For Myself'}</dd></div>}
              {isGiftOrder && <><div><dt>Buyer Name</dt><dd>{order.userName || order.customerName}</dd></div><div><dt>Buyer Email</dt><dd>{order.userEmail || order.email}</dd></div><div><dt>Recipient Email</dt><dd>{order.recipientEmail || 'Recipient at delivery address'}</dd></div></>}
              <div><dt>Order Date</dt><dd>{orderDate ? new Date(orderDate).toLocaleString() : 'Not available'}</dd></div>
              <div><dt>Payment Status</dt><dd>{order.paymentStatus || 'Not available'}</dd></div>
              <div><dt>Payment Method</dt><dd>{order.paymentMethod || 'Razorpay'}</dd></div>
              <div><dt>Total Paid</dt><dd>₹{money(order.total)}</dd></div>
              {order.paymentMethod === 'Wallet' && order.walletBalanceAfter != null && Number.isFinite(Number(order.walletBalanceAfter)) && <div><dt>Wallet Balance Remaining</dt><dd>₹{money(order.walletBalanceAfter)}</dd></div>}
            </dl>
          </section>}

          {stage >= 5 && order.scratchCardId && <section className="order-confirmation-card order-staged-card order-scratch-notice" aria-labelledby="order-scratch-notice-title"><h2 id="order-scratch-notice-title">Congratulations! You've unlocked a Scratch Card! 🎉</h2><p>Your reward is ready when you are.</p><Link className="primary-btn small" to="/account/scratch-cards">Scratch Now</Link></section>}

          {stage >= 5 && !isPromoCodeOrder && <section className="order-confirmation-card order-staged-card" aria-labelledby="order-products-title">
            <h2 id="order-products-title">Products</h2>
            {(order.items || []).length ? <ul className="order-product-list">{order.items.map((item, index) => <li key={`${item.id || item.name}-${index}`}><span>{item.name} × {item.quantity}</span><strong>₹{money(Number(item.price || 0) * Number(item.quantity || 0))}</strong></li>)}</ul> : <p>No product details are available.</p>}
          </section>}

          {stage >= 5 && !isPromoCodeOrder && order.projectDescription && <section className="order-confirmation-card order-staged-card" aria-labelledby="order-customization-title">
            <h2 id="order-customization-title">Your Customization / Requirements</h2>
            <p className="order-requirements-text">{order.projectDescription}</p>
          </section>}

          {stage >= 6 && !isPromoCodeOrder && <section className="order-confirmation-card order-staged-card" aria-labelledby="order-configuration-title">
            <h2 id="order-configuration-title">Order Configuration</h2>
            <dl className="order-information-list">
              {order.service && <div><dt>Package</dt><dd>{packageLabels[order.service] || order.service}</dd></div>}
              {order.service && <div><dt>Coding</dt><dd>{['coding', 'full'].includes(order.service) ? 'Yes' : 'No'}</dd></div>}
              {order.service && <div><dt>Building</dt><dd>{['building', 'full'].includes(order.service) ? 'Yes' : 'No'}</dd></div>}
              {order.projectDescription && <div className="order-requirements-row"><dt>Project Requirements</dt><dd>{order.projectDescription}</dd></div>}
            </dl>
          </section>}

          {stage >= 7 && !isPromoCodeOrder && <section className="order-confirmation-card order-staged-card" aria-labelledby="order-delivery-title">
            <h2 id="order-delivery-title">Delivery</h2>
            <dl className="order-information-list"><div><dt>Estimated Delivery</dt><dd>{deliveryDate}</dd></div><div><dt>Current Status</dt><dd>{order.orderStatus || 'Pending admin confirmation'}</dd></div></dl>
          </section>}

          {stage >= 7 && order.refundCase && <OrderRefundStatus refundCase={order.refundCase} />}
          {stage >= 8 && <p className="order-confirmation-thank-you">{order.orderStatus === 'Declined' ? 'Your refund is complete.' : 'Thank you for your order!'}</p>}
        </>}
      </div>
    </main>
    {discountRevealOpen && <div className="wallet-lock-overlay"><section className="wallet-pin-modal discount-purchase-success" role="dialog" aria-modal="true" aria-labelledby="discount-purchased-title"><h2 id="discount-purchased-title">Discount Promo Code Purchased</h2><p>Copy this code and use it in your cart to get your discount.</p>{purchasedDiscountCodes.map((item) => <div className="discount-order-reveal-code" key={item.purchaseId || item.code}><span>{item.offerName || 'Promo Code'}</span><code>{item.code}</code><small>{item.discountLabel || (item.discountType === 'fixed' ? `₹${item.discountValue} off` : `${item.discountValue}% off`)}</small><button type="button" className="secondary-btn" onClick={() => copyDiscountCode(item.code)}>{copyState}</button></div>)}<button type="button" className="primary-btn full" onClick={() => setDiscountRevealOpen(false)}>Continue</button></section></div>}
    </>
  );
}

function OrderRefundStatus({ refundCase }) {
  const [refund, setRefund] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    requestApi(`/api/refunds/${encodeURIComponent(refundCase._id)}`).then((result) => { if (active) setRefund(result.refund); })
      .catch((requestError) => { if (active) setError(requestError.message); });
    return () => { active = false; };
  }, [refundCase._id]);
  const isDeclineRefund = refund?.reasonCategory === 'Order Decline';
  const isOfflinePromoRefund = refund?.reasonCategory === 'Offline Promo Order Rejection';
  const walletCreditedRefund = isDeclineRefund || isOfflinePromoRefund;
  const orderSnapshot = refund?.orderSnapshot || {};
  return <section className="order-confirmation-card order-staged-card" aria-labelledby="order-refund-status-title">
    <h2 id="order-refund-status-title">Refund Status</h2>
    <dl className="order-information-list">
      <div><dt>Refund Case</dt><dd>{refundCase.refundCaseId}</dd></div>
      <div><dt>Refund Status</dt><dd>{refundStatusLabel(refund?.status || refundCase.status)}</dd></div>
      {isDeclineRefund && <>
        <div><dt>Parts Amount</dt><dd>₹{Number(orderSnapshot.subtotal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
        <div><dt>Coding Charge</dt><dd>₹{Number(orderSnapshot.codingCharge || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
        <div><dt>Building Charge</dt><dd>₹{Number(orderSnapshot.buildingCharge || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
        <div><dt>Delivery Charge (not refunded)</dt><dd>₹{Number(orderSnapshot.deliveryCharge || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
        <div><dt>Total Amount Paid</dt><dd>₹{Number(orderSnapshot.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
      </>}
      {refund && <>
        <div><dt>{walletCreditedRefund ? 'Refundable Amount' : 'Approved Refund'}</dt><dd>₹{((refund.approvedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>
        {walletCreditedRefund && <div><dt>Amount Credited to Wallet</dt><dd>₹{((refund.approvedRefundAmountPaise ?? refund.refundAmountPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div>}
        <div><dt>Wallet Transaction Reference</dt><dd>{refund.walletTransactionReferenceId || 'Not available'}</dd></div>
      </>}
    </dl>
    {isDeclineRefund && <p>Your order was declined by the admin. The refundable parts amount has been credited to your wallet.</p>}
    {isOfflinePromoRefund && <p>Your offline Promo Code order was rejected. The refunded purchase amount has been credited to your wallet.</p>}
    {refund && <RefundTimeline refund={refund} />}
    {error && <p>{error}</p>}
    <Link className="secondary-btn small" to={`/refunds/${refundCase._id}`}>View Refund Status</Link>
  </section>;
}

function Modal({ children, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </div>
    </div>
  );
}

function PromoGiftReceivedModal({ notification, onClose, onView }) {
  const gift = notification.data || {};
  return <div className="wallet-lock-overlay promo-gift-overlay"><section className="promo-gift-modal" role="dialog" aria-modal="true" aria-labelledby="promo-gift-title">
    <span className="promo-gift-icon" aria-hidden="true">🎁</span>
    <span className="eyebrow">A gift for you</span>
    <h2 id="promo-gift-title">You've Received a Gift!</h2>
    <p>Someone has purchased a promo code for you.</p>
    <dl><div><dt>From</dt><dd>{gift.buyerName || 'Innovation Labs customer'}</dd></div><div><dt>Buyer's Email</dt><dd>{gift.buyerEmail || 'Not available'}</dd></div><div><dt>Promo Code</dt><dd>{gift.promoName || 'Digital Wallet Credit'}</dd></div><div><dt>Wallet Credit Value</dt><dd>₹{Number(gift.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</dd></div><div><dt>Received</dt><dd>{gift.receivedAt ? new Date(gift.receivedAt).toLocaleString() : new Date(notification.createdAt).toLocaleString()}</dd></div></dl>
    <div className="modal-actions"><button className="secondary-btn" onClick={onClose}>Close</button><button className="primary-btn" onClick={onView}>View My Gift</button></div>
  </section></div>;
}

function GoogleLoginModal({ onSuccess, onClose }) {
  const googleRef = useRef(null);
  const onSuccessRef = useRef(onSuccess);

  onSuccessRef.current = onSuccess;

  useEffect(() => {
    if (!window.google || !GOOGLE_CLIENT_ID) {
      return;
    }

    if (!googleIdentityInitialized) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => onSuccessRef.current(response),
      });
      googleIdentityInitialized = true;
    }

    if (googleRef.current) {
      window.google.accounts.id.renderButton(googleRef.current, {
        theme: 'filled_blue',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
      });
    }
  }, []);

  return (
    <div className="modal-content">
      <h3>Continue with Google</h3>
      <p>Use your real Google account to sign in securely and place your order.</p>
      {!GOOGLE_CLIENT_ID ? (
        <div className="alert-box">
          Google sign-in is not configured yet. Add VITE_GOOGLE_CLIENT_ID in your environment variables.
        </div>
      ) : (
        <div ref={googleRef} className="google-login-button" />
      )}
      <button className="secondary-btn full" onClick={onClose}>Cancel</button>
    </div>
  );
}

function RequireSignInModal({ onClose, onSignIn }) {
  return (
    <div className="modal-content">
      <h3>Sign in required</h3>
      <p>You must sign in before you can place your order.</p>
      <div className="modal-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={onSignIn}>Continue with Google</button>
      </div>
    </div>
  );
}

function SignInReminderModal({ repeat, onClose, onSignIn }) {
  return (
    <div className="modal-content">
      <h3>Build your imagination to life. Why are you waiting? Do it now.</h3>
      <p>You can sign in to buy and build your imagination to life.</p>
      <div className="modal-actions">
        {!repeat && <button className="secondary-btn" onClick={onClose}>Cancel</button>}
        <button className="primary-btn" onClick={onSignIn}>Sign In</button>
      </div>
    </div>
  );
}

function ProjectPreferencesModal({ value, onClose, onSave }) {
  const [text, setText] = useState(value || '');
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const recognitionRef = useRef(null);
  const voiceStateRef = useRef('idle');
  const shouldListenRef = useRef(false);
  const permissionPendingRef = useRef(false);
  const attemptRef = useRef(0);
  const finalTranscriptRef = useRef('');
  const interimTranscriptRef = useRef('');
  const restartTimerRef = useRef(null);

  const updateVoiceTranscript = () => {
    setVoiceTranscript([finalTranscriptRef.current, interimTranscriptRef.current]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim());
  };

  const stopRecognition = (abort = true) => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    shouldListenRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    try {
      if (abort) recognition.abort();
      else recognition.stop();
    } catch {
      // Recognition may already have ended.
    }
  };

  const launchRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !shouldListenRef.current || voiceStateRef.current !== 'recording') return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognitionRef.current = recognition;

    recognition.onstart = () => {
      if (recognitionRef.current === recognition) setVoiceError('');
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const phrase = result[0]?.transcript?.trim();
        if (!phrase) continue;
        if (result.isFinal) {
          finalTranscriptRef.current = appendVoiceText(finalTranscriptRef.current, phrase);
        } else {
          interim = appendVoiceText(interim, phrase);
        }
      }
      interimTranscriptRef.current = interim;
      updateVoiceTranscript();
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      const messages = {
        'not-allowed': 'Microphone permission was denied. Please allow microphone access or type your idea.',
        'permission-denied': 'Microphone permission was denied. Please allow microphone access or type your idea.',
        'service-not-allowed': 'Voice input is unavailable. Please check browser permissions or type your idea.',
        'no-speech': 'No speech was detected. Try speaking again.',
        'audio-capture': 'A microphone could not be found. Check your microphone and try again.',
        network: 'Voice recognition needs an internet connection. Check your connection and try again.',
        aborted: 'Voice input stopped. You can start again when ready.',
      };
      const message = messages[event.error] || 'Voice input ran into a problem. Please try again or type your idea.';
      if (event.error !== 'aborted' || voiceStateRef.current === 'recording') setVoiceError(message);

      if (!['no-speech'].includes(event.error)) {
        shouldListenRef.current = false;
        voiceStateRef.current = 'idle';
        setVoiceState('idle');
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (!shouldListenRef.current || voiceStateRef.current !== 'recording') return;

      restartTimerRef.current = setTimeout(() => {
        if (shouldListenRef.current && voiceStateRef.current === 'recording') launchRecognition();
      }, 250);
    };

    try {
      recognition.start();
    } catch {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      shouldListenRef.current = false;
      voiceStateRef.current = 'idle';
      setVoiceState('idle');
      setVoiceError('Could not start voice input. Check microphone access or type your idea.');
    }
  };

  const startVoice = async () => {
    if (voiceStateRef.current !== 'idle' || isStarting || permissionPendingRef.current) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError("Voice input isn't supported in this browser. Please use a supported browser or type your idea.");
      return;
    }

    const attempt = ++attemptRef.current;
    permissionPendingRef.current = true;
    setIsStarting(true);
    setVoiceError('');

    try {
      if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      }
      if (attempt !== attemptRef.current) return;
      voiceStateRef.current = 'recording';
      setVoiceState('recording');
      shouldListenRef.current = true;
      launchRecognition();
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      const denied = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name);
      setVoiceError(denied
        ? 'Microphone permission was denied. Please allow microphone access or type your idea.'
        : 'Could not access the microphone. Check your microphone and browser permissions, or type your idea.');
    } finally {
      if (attempt === attemptRef.current) {
        permissionPendingRef.current = false;
        setIsStarting(false);
      }
    }
  };

  const pauseVoice = () => {
    if (voiceStateRef.current !== 'recording') return;
    voiceStateRef.current = 'paused';
    setVoiceState('paused');
    shouldListenRef.current = false;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    const recognition = recognitionRef.current;
    try {
      recognition?.stop();
    } catch {
      // Recognition may already have ended.
    }
  };

  const resumeVoice = () => {
    if (voiceStateRef.current !== 'paused') return;
    voiceStateRef.current = 'recording';
    setVoiceState('recording');
    setVoiceError('');
    shouldListenRef.current = true;
    if (!recognitionRef.current) launchRecognition();
  };

  const clearVoice = () => {
    attemptRef.current += 1;
    permissionPendingRef.current = false;
    setIsStarting(false);
    stopRecognition(true);
    voiceStateRef.current = 'idle';
    setVoiceState('idle');
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    setVoiceTranscript('');
    setVoiceError('');
  };

  const acceptVoice = () => {
    const transcript = [finalTranscriptRef.current, interimTranscriptRef.current]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (transcript) setText((current) => appendVoiceText(current, transcript));
    clearVoice();
  };

  useEffect(() => () => {
    attemptRef.current += 1;
    permissionPendingRef.current = false;
    stopRecognition(true);
    voiceStateRef.current = 'idle';
  }, []);

  const confirmText = () => {
    if (!text.trim()) {
      window.alert('Please describe your idea before continuing.');
      return;
    }
    onSave(text.trim());
    onClose();
  };

  const hasTemporaryTranscript = Boolean(voiceTranscript.trim());

  return (
    <div className="modal-content preferences-modal-content">
      <div className="preferences-intro">
        <h3>Enter Your Preferences</h3>
        <p>Tell us what you want to make. Describe your idea and we’ll help bring it to life.</p>
      </div>

      <div className="voice-wrap">
        <textarea
          className="preferences-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Describe your project idea..."
          aria-label="Describe your project idea"
        />
        <button
          type="button"
          className={`voice-mic ${voiceState === 'recording' ? 'listening' : ''}`}
          onClick={startVoice}
          disabled={voiceState !== 'idle' || isStarting}
          title={isStarting ? 'Requesting microphone access' : 'Start voice input'}
          aria-label={isStarting ? 'Requesting microphone access' : 'Start voice input'}
        >
          {isStarting ? <span className="voice-spinner" aria-hidden="true" /> : voiceState === 'recording'
            ? <><span className="voice-live-dot" />Listening...</>
            : <><span aria-hidden="true">🎙</span><span className="sr-only">Start voice input</span></>}
        </button>
      </div>

      {(voiceState !== 'idle' || hasTemporaryTranscript) && (
        <div className="voice-console">
          <div className="voice-controls">
            {voiceState === 'recording' && (
              <button type="button" className="voice-control pause" onClick={pauseVoice} title="Temporarily stop recording" aria-label="Temporarily stop recording">
                <span aria-hidden="true">⏸</span> Temporarily Stop
              </button>
            )}
            {voiceState === 'paused' && (
              <button type="button" className="voice-control resume" onClick={resumeVoice} title="Resume recording" aria-label="Resume recording">
                <span aria-hidden="true">▶</span> Resume
              </button>
            )}
            {(voiceState !== 'idle' || hasTemporaryTranscript) && (
              <>
                <button type="button" className="voice-icon-control accept" onClick={acceptVoice} title="Accept transcript" aria-label="Accept transcript">✓</button>
                <button type="button" className="voice-icon-control discard" onClick={clearVoice} title="Discard transcript" aria-label="Discard transcript">✕</button>
              </>
            )}
          </div>
          {hasTemporaryTranscript && (
            <div className="voice-result" aria-live="polite">
              <strong>{voiceState === 'paused' ? 'Paused transcript' : voiceState === 'recording' ? 'Live transcript' : 'Temporary transcript'}</strong>
              <p>“{voiceTranscript}”</p>
            </div>
          )}
        </div>
      )}

      {voiceError && <div className="voice-error" role="status">{voiceError}</div>}

      <div className="modal-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={confirmText}>Confirm</button>
      </div>
    </div>
  );
}

function PaymentErrorModal({ message, onClose }) {
  return (
    <div className="modal-content">
      <h3>Payment issue</h3>
      <p>{message}</p>
      <button className="primary-btn full" onClick={onClose}>OK</button>
    </div>
  );
}

function OrderCancellationModal({ order, onCancel, onConfirm }) {
  const [stage, setStage] = useState('reason');
  const [reasonChoice, setReasonChoice] = useState('I ordered by mistake');
  const [customReason, setCustomReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotencyKey = useRef(globalThis.crypto?.randomUUID?.() || `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const reasons = [
    'I ordered by mistake',
    'I no longer need the product',
    'I want to change my order',
    'I selected the wrong product',
    'I selected the wrong quantity',
    'Delivery time is too long',
    'I found another option',
    'I entered incorrect order details',
    'Payment issue',
    'Other',
  ];
  const reason = reasonChoice === 'Other' ? customReason.trim() : reasonChoice;
  const continueToConfirm = (event) => {
    event.preventDefault();
    if (!reason) {
      setError('Enter a reason for cancelling this order.');
      return;
    }
    setError('');
    setStage('confirm');
  };
  const submit = async () => {
    if (busy || !reason) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(order, reason, idempotencyKey.current);
    } catch (requestError) {
      setError(requestError.message || 'We could not cancel this order. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const orderId = order.orderId || order.id;

  if (stage === 'reason') return <form className="modal-content order-cancel-form" onSubmit={continueToConfirm}>
    <h3>Cancel Order</h3>
    <p>Why do you want to cancel this order?</p>
    <label>Cancellation reason<select value={reasonChoice} onChange={(event) => { setReasonChoice(event.target.value); setError(''); }}><option disabled value="">Select a reason</option>{reasons.map((item) => <option key={item}>{item}</option>)}</select></label>
    {reasonChoice === 'Other' && <label>Enter your reason<textarea value={customReason} onChange={(event) => { setCustomReason(event.target.value); setError(''); }} maxLength={1000} required /></label>}
    {error && <div className="voice-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-btn" onClick={onCancel}>Back</button><button className="primary-btn" disabled={reasonChoice === 'Other' && !customReason.trim()}>Continue</button></div>
  </form>;

  return <div className="modal-content order-cancel-confirm"><h3>Confirm Cancellation</h3><p>You are about to cancel this order.</p><dl><div><dt>Order ID</dt><dd>{orderId}</dd></div><div><dt>Cancellation reason</dt><dd>{reason}</dd></div></dl><p>Because this order was paid using your Wallet, ₹{Number(order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} will be returned to your Wallet after cancellation.</p><p>Do you want to cancel this order?</p>{error && <div className="voice-error" role="alert">{error}</div>}<div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={() => setStage('reason')}>Back</button><button className="primary-btn" disabled={busy} onClick={submit}>{busy ? 'Cancelling...' : 'Yes, Cancel Order'}</button></div></div>;
}

function OrderCancellationSuccessModal({ order, cancellation, wallet, onViewWallet, onViewOrder }) {
  return <div className="modal-content order-cancel-success"><div className="transfer-success-icon" aria-hidden="true">✓</div><h3>Order Cancelled</h3><p>Your order has been successfully cancelled.</p><p>₹{Number(cancellation.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })} has been returned to your Wallet.</p><div className="order-cancel-success-details"><span>Order #{order.orderId || order.id}</span><span>Wallet balance: ₹{Number(wallet.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div><div className="modal-actions"><button className="secondary-btn" onClick={onViewWallet}>View Wallet</button><button className="primary-btn" onClick={onViewOrder}>View Order</button></div></div>;
}

function ConfirmCustomOrderModal({ itemName, onConfirm, onCancel }) {
  return (
    <div className="modal-content">
      <h3>Confirm Custom Order</h3>
      <p>Are you agreeing to deliver {itemName} to the customer?</p>
      <div className="modal-actions">
        <button className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button className="primary-btn" onClick={onConfirm}>Yes, Accept</button>
      </div>
    </div>
  );
}

export default App;
