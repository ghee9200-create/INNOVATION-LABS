import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { OAuth2Client } from 'google-auth-library';
import { GoogleGenAI, Type } from '@google/genai';
import mongoose from 'mongoose';
import { calculateCancellationRefund, resolveCancellationItems } from './cancellationRefund.js';
import { calculateOrder } from './orderPricing.js';
import { calculateSubscriptionDiscount, SUBSCRIPTION_DISCOUNT_PERCENT } from './subscriptionPricing.js';
import { inquiryAddDays as addInquiryDays, isInquiryDateBookable } from './inquiryBookingRules.js';

const app = express();
const uploadRefundEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Evidence must be a JPEG, PNG, or WebP image.'));
    }
    return callback(null, true);
  },
});
const uploadReviewImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Review images must be JPEG, PNG, or WebP files.'));
    }
    return callback(null, true);
  },
});
const port = Number(process.env.PORT || 3001);
const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const sessionSecret = process.env.SESSION_SECRET;
const configuredRefundEligibilityDays = Number(process.env.REFUND_ELIGIBILITY_DAYS || 4);
const maxSubscriptionDurationMonths = 12;
const refundEligibilityDays = Number.isFinite(configuredRefundEligibilityDays) && configuredRefundEligibilityDays > 0
  ? configuredRefundEligibilityDays
  : 4;
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminPasswordHash = adminPassword
  ? crypto.scryptSync(adminPassword, sessionSecret || 'admin-password-v1', 64)
  : null;
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const policyVersion = '2026-10-27';
const planDisplayNames = { Starter: 'Starter', Medium: 'Plus', Premium: 'Pro', Exclusive: 'Exclusive' };
const displayPlanName = (plan) => planDisplayNames[plan] || plan || '';
const displayPlanText = (text) => String(text || '')
  .replace(/\bMedium\b/g, 'Plus')
  .replace(/\bPremium\b/g, 'Pro')
  .replace(/\bAlpha\b/g, 'Plus')
  .replace(/\bBeta\b/g, 'Pro')
  .replace(/\bTheta\b/g, 'Exclusive');
const planConfig = {
  Starter: { pricePaise: 0, credits: 0, cashbackPaise: 0, walletLimitPaise: 500000, includedAiBills: 2 },
  Medium: { pricePaise: Number(process.env.PLAN_MEDIUM_PRICE_PAISE || 699900), credits: 0, cashbackPaise: 0, walletLimitPaise: 1000000, includedAiBills: 2 },
  Premium: { pricePaise: Number(process.env.PLAN_PREMIUM_PRICE_PAISE || 999900), credits: 520, cashbackPaise: 19900, walletLimitPaise: 1500000, includedAiBills: 2 },
  Exclusive: { pricePaise: Number(process.env.PLAN_EXCLUSIVE_PRICE_PAISE || 199900), credits: 2020, cashbackPaise: 29900, walletLimitPaise: 2000000, includedAiBills: 4 },
};
const orderItemsSnapshot = (items) => items.map((item) => ({
  ...item,
  unitPricePaise: toPaise(item.price),
  lineTotalPaise: toPaise(item.price) * item.quantity,
}));
const aiBillAllowanceByPlan = Object.fromEntries(Object.entries(planConfig).map(([plan, config]) => [plan, Number(config.includedAiBills || 0)]));
const walletLimitByPlan = Object.fromEntries(Object.entries(planConfig).map(([plan, config]) => [plan, Number(config.walletLimitPaise || 0)]));
const aiCreditCosts = {
  chat: Number(process.env.AI_CHAT_CREDIT_COST || 1),
  search: Number(process.env.AI_SEARCH_CREDIT_COST || 50),
  purchase: Number(process.env.AI_PURCHASE_CREDIT_COST || 100),
};
const aiCreditPricePaise = Number(process.env.AI_CREDIT_PRICE_PAISE || 200);
const aiCreditMaxPurchase = Number(process.env.AI_CREDIT_MAX_PURCHASE || 10000);
const aiCreditPackages = [100, 500, 1000];
let databaseDiagnostic = { state: 'connecting', errorType: null };
const giftRecipientAttempts = new Map();
const revokedSessionIds = new Set();
const sseUserClients = new Map();
const sseAdminClients = new Set();
const googleClient = new OAuth2Client(googleClientId);
const User = mongoose.model('User', new mongoose.Schema({
  googleId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, index: true },
  picture: String,
  phoneNumber: { type: String, default: '' },
  dateOfBirth: Date,
  purchaseAgeDeclaredAt: Date,
  ageVerificationStatus: { type: String, enum: ['pending', 'verified', 'restricted'], default: 'pending', index: true },
  accountStatus: { type: String, enum: ['active', 'restricted'], default: 'active', index: true },
  ageVerificationDate: Date,
  restrictionReason: { type: String, default: '' },
  restrictedAt: Date,
  reactivationHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  recipientAddresses: { type: [mongoose.Schema.Types.Mixed], default: [] },
  promoEligibleAt: Date,
  address: {
    fullName: String,
    phoneNumber: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    pinCode: String,
    country: String,
  },
}, { timestamps: true }));
const AgeVerificationEvent = mongoose.model('AgeVerificationEvent', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  eventType: { type: String, enum: ['restricted', 'verified', 'reactivated'], required: true },
  dateOfBirth: Date,
  reason: { type: String, default: '' },
  actorUserId: { type: String, default: '' },
  createdAt: { type: Date, required: true, default: Date.now },
}, { timestamps: false }));
const PolicyConsent = mongoose.model('PolicyConsent', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  policyVersion: { type: String, required: true },
  consentedAt: { type: Date, required: true },
}, { timestamps: true }));
PolicyConsent.schema.index({ userId: 1, policyVersion: 1 }, { unique: true });
const CustomOrderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true, lowercase: true },
  requestedItem: { type: String, required: true, trim: true, maxlength: 120 },
  normalizedItem: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Accepted', 'Rejected', 'Ordered'], default: 'Pending' },
  price: { type: Number, min: 1, default: null },
  acceptedAt: Date,
  orderedAt: Date,
}, { timestamps: true });
CustomOrderSchema.index(
  { userId: 1, normalizedItem: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending' } },
);
const CustomOrder = mongoose.model('CustomOrder', CustomOrderSchema);
const Order = mongoose.model('Order', new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  orderCategory: { type: String, enum: ['PART_ORDER', 'SUBSCRIPTION_ORDER'], default: 'PART_ORDER', index: true },
  orderType: { type: String, enum: ['PRODUCT', 'PROMO_CODE', 'DISCOUNT_CODE'], default: 'PRODUCT', index: true },
  purchaseType: { type: String, enum: ['online', 'offline'] },
  recipientType: { type: String, enum: ['myself', 'gift'] },
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true, lowercase: true },
  items: [{
    id: { type: String, required: true },
    customOrderId: String,
    discountOfferId: String,
    name: { type: String, required: true },
    category: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    unitPricePaise: { type: Number, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalPaise: { type: Number, min: 0 },
    cancellable: { type: Boolean, default: true },
    cancelledQuantity: { type: Number, min: 0, default: 0 },
    fulfillmentStatus: { type: String },
    cancellations: [{
      cancellationId: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      reason: { type: String, required: true },
      cancelledBy: { type: String, required: true },
      source: { type: String, enum: ['CUSTOMER', 'ADMIN'], required: true },
      cancelledAt: { type: Date, required: true },
    }],
  }],
  address: { type: mongoose.Schema.Types.Mixed, required: function() { return this.deliveryRequired !== false; } },
  buyerAddress: mongoose.Schema.Types.Mixed,
  recipientAddress: mongoose.Schema.Types.Mixed,
  recipientUserId: String,
  recipientEmail: String,
  deliveryRequired: { type: Boolean, default: true },
  promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode' },
  promoCode: String,
  promoCodeAmountPaise: { type: Number, min: 0 },
  rewardPointsEarned: { type: Number, min: 0, default: 0 },
  promoCodeStatus: { type: String, enum: ['PURCHASED', 'PARTIALLY_REDEEMED', 'REDEEMED', 'EXPIRED', 'FULLY_REDEEMED'] },
  promoActivationStatus: { type: String, enum: ['pending', 'active', 'expired', 'fully_redeemed', 'rejected'] },
  promoActivatedAt: Date,
  promoExpiresAt: Date,
  promoMaxUses: { type: Number, min: 1 },
  promoSuccessfulUses: { type: Number, min: 0, default: 0 },
  promoReservationId: String,
  discountCode: String,
  discountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  discountCodePurchaseId: String,
  scratchCardId: String,
  refundAmountPaise: { type: Number, min: 0 },
  refundTransactionReferenceId: String,
  refundStatus: { type: String, enum: ['Pending', 'Completed', 'Failed'] },
  refundDestination: { type: String, enum: ['Innovation Labs Wallet', 'Razorpay'] },
  refundReason: String,
  refundCreatedAt: Date,
  refundCompletedAt: Date,
  verifiedAmountPaidPaise: { type: Number, min: 0 },
  paymentVerifiedAt: Date,
  originalPaymentReference: String,
  service: { type: String, enum: ['parts', 'coding', 'building', 'full'], default: 'parts' },
  projectDescription: { type: String, default: '' },
  subtotal: { type: Number, required: true, min: 0 },
  codingCharge: { type: Number, default: 0 },
  buildingCharge: { type: Number, default: 0 },
  deliveryCharge: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, default: 'Paid' },
  paymentMethod: { type: String, enum: ['Razorpay', 'Wallet', 'Wallet QR'], default: 'Razorpay' },
  payerWalletId: String,
  walletBalanceAfterPaise: { type: Number, min: 0 },
  inventoryDeductedAt: Date,
  refundCaseId: { type: String, default: null },
  acceptedAt: Date,
  cancelledAt: Date,
  cancellationId: { type: String, default: null },
  cancellationIdempotencyKey: String,
  cancellationReason: String,
  cancellationType: String,
  cancellationSource: { type: String, enum: ['ADMIN', 'CUSTOMER'] },
  cancellationDeductionsPaise: { type: Number, min: 0, default: 0 },
  cancellationRefundedPaise: { type: Number, min: 0, default: 0 },
  cancellationEvents: [{
    cancellationId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    reason: { type: String, required: true },
    userEmail: String,
    items: [{ itemIndex: Number, quantity: Number, amountPaise: Number }],
    originalAmountPaise: { type: Number, min: 0 },
    refundAmountPaise: { type: Number, min: 0, required: true },
    deductionsPaise: { type: Number, min: 0, required: true },
    totalNonRefundableChargesPaise: { type: Number, min: 0 },
    walletBalanceAfterPaise: { type: Number, min: 0 },
    refundStatus: { type: String, enum: ['Pending', 'Completed', 'Failed'] },
    refundDestination: { type: String, enum: ['Innovation Labs Wallet', 'Razorpay'] },
    refundTransactionReferenceId: String,
    complete: { type: Boolean, default: false },
    walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
    createdAt: { type: Date, default: Date.now },
  }],
  cancelledBy: String,
  cancellationRefundAmountPaise: { type: Number, min: 0 },
  cancellationRefundTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  cancellationBalanceAfterPaise: { type: Number, min: 0 },
  orderStatus: { type: String, default: 'Processing' },
  approvalStatus: { type: String, enum: ['pending', 'accepted', 'rejected', 'not_required'] },
  estimatedDelivery: { type: Date },
  statusHistory: [{ status: String, note: String, createdAt: Date }],
  razorpayId: String,
  checkoutReference: { type: String, unique: true, sparse: true },
}, { timestamps: true }));
Order.schema.index({ razorpayId: 1 }, { unique: true, sparse: true });
const Notification = mongoose.model('Notification', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  customOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomOrder' },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
    type: { type: String, default: 'general', index: true },
    data: mongoose.Schema.Types.Mixed,
}, { timestamps: true }));
const RevokedSession = mongoose.model('RevokedSession', new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true }));
const InventoryItem = mongoose.model('InventoryItem', new mongoose.Schema({
  productId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  category: { type: String, trim: true, default: 'Other Components' },
  pricePaise: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  images: { type: [String], default: [] },
  technicalSpecs: { type: mongoose.Schema.Types.Mixed, default: {} },
  cancellable: { type: Boolean, default: true },
  stock: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, enum: ['In Stock', 'Low Stock', 'Out of Stock'], default: 'In Stock' },
  updatedBy: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const ProductReview = mongoose.model('ProductReview', new mongoose.Schema({
  reviewId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  customerName: { type: String, required: true },
  productId: { type: String, required: true, index: true },
  productName: { type: String, required: true },
  orderId: { type: String, required: true, index: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  description: { type: String, default: '', maxlength: 2000 },
  images: [{
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    originalName: { type: String, required: true },
  }],
  verifiedPurchase: { type: Boolean, required: true, default: true },
  moderationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  moderatedBy: String,
  moderatedAt: Date,
}, { timestamps: true }));
ProductReview.schema.index({ userId: 1, productId: 1 }, { unique: true });
ProductReview.schema.index({ productId: 1, moderationStatus: 1, createdAt: -1 });
const BackInStockSubscription = mongoose.model('BackInStockSubscription', new mongoose.Schema({
  productId: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  email: { type: String, required: true, lowercase: true },
  notifiedAt: Date,
}, { timestamps: true }));
BackInStockSubscription.schema.index({ productId: 1, userId: 1 }, { unique: true });
const AdminSetting = mongoose.model('AdminSetting', new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const AdminAuditLog = mongoose.model('AdminAuditLog', new mongoose.Schema({
  adminId: { type: String, required: true, index: true },
  action: { type: String, required: true, maxlength: 240 },
  route: { type: String, required: true, maxlength: 240 },
  responseStatus: { type: Number, required: true },
}, { timestamps: true }));
const AdminVerificationAttempt = mongoose.model('AdminVerificationAttempt', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  failures: { type: Number, required: true, default: 0 },
  windowStartedAt: { type: Date, required: true },
  lockedUntil: { type: Date, default: null },
}, { timestamps: true }));
AdminAuditLog.schema.index({ adminId: 1, createdAt: -1 });
const WalletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  walletId: { type: String, uppercase: true, match: /^@WL[A-Z]{4}\d{4}$/ },
  qrReference: { type: String, select: false },
  balancePaise: { type: Number, required: true, min: 0, default: 0 },
  totalBalancePaise: { type: Number, required: true, min: 0, default: 0 },
  availableBalancePaise: { type: Number, required: true, min: 0, default: 0 },
  restrictedBalancePaise: { type: Number, required: true, min: 0, default: 0 },
  pinHash: { type: String, default: '' },
  failedPinAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
  effectivePlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  previousPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  graceStartedAt: Date,
  graceEndsAt: Date,
  balanceRestrictionActive: { type: Boolean, default: false },
  lockAppliedAt: Date,
  restrictionStateKey: { type: String, default: '' },
}, { timestamps: true });
WalletSchema.pre('save', function syncWalletBalanceFields() {
  this.totalBalancePaise = this.balancePaise;
  this.availableBalancePaise = Math.max(0, this.balancePaise - this.restrictedBalancePaise);
});
WalletSchema.index({ walletId: 1 }, { unique: true, sparse: true });
WalletSchema.index({ qrReference: 1 }, { unique: true, sparse: true });
const Wallet = mongoose.model('Wallet', WalletSchema);
const WalletTransaction = mongoose.model('WalletTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  userEmail: { type: String, lowercase: true },
  type: { type: String, enum: ['Recharge', 'Purchase', 'Refund', 'Order Decline Refund', 'Wallet Payment', 'Promo Code', 'Reward Points', 'Adjustment', 'Wallet Restriction', 'Wallet Restriction Reversal', 'Money Sent', 'Money Received', 'Cancellation Refund'], required: true },
  amountPaise: { type: Number, required: true },
  balanceBeforePaise: { type: Number, required: true },
  balanceAfterPaise: { type: Number, required: true },
  availableBalanceAfterPaise: { type: Number, min: 0 },
  referenceId: { type: String, required: true, unique: true },
  orderId: String,
  refundCaseId: String,
  originalPaymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  originalPaymentReference: String,
  refundDestination: { type: String, enum: ['Innovation Labs Wallet', 'Razorpay'] },
  cancellationSource: { type: String, enum: ['ADMIN', 'CUSTOMER'] },
  refundDeductionsPaise: { type: Number, min: 0, default: 0 },
  cancellationId: String,
  transferId: String,
  peerWalletId: String,
  payerWalletId: String,
  description: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Successful', 'Failed', 'Completed'], default: 'Successful' },
}, { timestamps: true }));
const RewardAccount = mongoose.model('RewardAccount', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  availablePoints: { type: Number, required: true, default: 0 },
  lifetimePointsEarned: { type: Number, required: true, default: 0, min: 0 },
  lifetimePointsRedeemed: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true }));
const RewardTransaction = mongoose.model('RewardTransaction', new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  userEmail: { type: String, lowercase: true, index: true },
  orderId: { type: String, index: true },
  transactionType: { type: String, enum: ['earned', 'redeemed', 'reversed'], required: true },
  productType: { type: String, default: '' },
  eligibleAmountPaise: { type: Number, required: true, min: 0, default: 0 },
  points: { type: Number, required: true, min: 1 },
  walletAmountPaise: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, enum: ['earned', 'redeemed', 'reversed'], required: true },
}, { timestamps: true }));
RewardTransaction.schema.index({ userId: 1, createdAt: -1 });
RewardTransaction.schema.index({ orderId: 1, transactionType: 1 });
const RewardRule = mongoose.model('RewardRule', new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'default' },
  minimumEligibleAmountPaise: { type: Number, required: true, min: 0, default: 10000 },
  firstTierMaximumPaise: { type: Number, required: true, min: 1, default: 100000 },
  firstTierPoints: { type: Number, required: true, min: 0, default: 5 },
  higherTierPoints: { type: Number, required: true, min: 0, default: 20 },
  updatedBy: String,
}, { timestamps: true }));
const DiscountCodeRegistry = mongoose.model('DiscountCodeRegistry', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, unique: true, index: true },
  sourceType: { type: String, enum: ['offer', 'scratch'], required: true },
  sourceId: { type: String, required: true },
}, { timestamps: true }));
const DiscountCodeOffer = mongoose.model('DiscountCodeOffer', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  source: { type: String, enum: ['ADMIN', 'AI_GENERATED', 'SCRATCH_CARD'], default: 'ADMIN', index: true },
  sellingPricePaise: { type: Number, required: true, min: 0 },
  discountType: { type: String, enum: ['fixed', 'percentage'], required: true },
  discountValuePaise: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  startsAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  maxRedemptions: { type: Number, required: true, min: 1 },
  maxRedemptionsPerCustomer: { type: Number, required: true, min: 1, default: 1 },
  availableQuantity: { type: Number, required: true, min: 0 },
  purchasedCount: { type: Number, default: 0, min: 0 },
  redeemedCount: { type: Number, default: 0, min: 0 },
  minimumPurchasePaise: { type: Number, default: 0, min: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true }));
DiscountCodeOffer.schema.index({ active: 1, startsAt: 1, expiresAt: 1 });
const PurchasedDiscountCode = mongoose.model('PurchasedDiscountCode', new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true, index: true },
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', default: null },
  code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/, index: true },
  userId: { type: String, required: true, index: true },
  purchaserUserId: { type: String, required: true, index: true },
  recipientEmail: { type: String, lowercase: true, trim: true },
  orderId: { type: String, required: true, index: true },
  sellingPricePaise: { type: Number, required: true, min: 0 },
  discountType: { type: String, enum: ['fixed', 'percentage'], required: true },
  discountValuePaise: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  minimumPurchasePaise: { type: Number, min: 0, default: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  maxRedemptions: { type: Number, required: true, min: 1, default: 1 },
  maxRedemptionsPerCustomer: { type: Number, required: true, min: 1, default: 1 },
  redemptionCount: { type: Number, required: true, default: 0, min: 0 },
  purchasedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  fulfillmentStatus: { type: String, enum: ['pending', 'fulfilled', 'rejected'], default: 'pending', index: true },
  isScratchReward: { type: Boolean, default: false },
  scratchCardId: String,
  transferable: { type: Boolean, default: false },
  source: { type: String, enum: ['ADMIN', 'AI_GENERATED', 'SCRATCH_CARD'], default: 'ADMIN' },
}, { timestamps: true }));
PurchasedDiscountCode.schema.index({ userId: 1, code: 1, fulfillmentStatus: 1 });
const DiscountPurchaseIntent = mongoose.model('DiscountPurchaseIntent', new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  assignedUserId: { type: String, required: true },
  recipientEmail: String,
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  baseAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  idempotencyKey: { type: String, required: true },
  status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending', index: true },
  paymentId: String,
  orderId: String,
}, { timestamps: true }));
DiscountPurchaseIntent.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
const DiscountRedemption = mongoose.model('DiscountRedemption', new mongoose.Schema({
  redemptionId: { type: String, required: true, unique: true, index: true },
  purchaseId: { type: String, required: true, index: true },
  offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCodeOffer', default: null },
  code: { type: String, required: true, uppercase: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  discountAmountPaise: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['reserved', 'redeemed', 'released', 'refunded'], default: 'redeemed', index: true },
  redeemedAt: Date,
}, { timestamps: true }));
const DiscountCodeUsage = mongoose.model('DiscountCodeUsage', new mongoose.Schema({
  code: { type: String, required: true, uppercase: true },
  userId: { type: String, required: true },
  redemptionCount: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true }));
DiscountCodeUsage.schema.index({ code: 1, userId: 1 }, { unique: true });
const ScratchSettings = mongoose.model('ScratchSettings', new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'default' },
  enabled: { type: Boolean, default: true },
  thresholdPaise: { type: Number, required: true, min: 0, default: 500000 },
  rewardValuesPaise: { type: [Number], default: [5000, 10000, 20000, 50000] },
  discountType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  minimumPurchasePaise: { type: Number, required: true, min: 0, default: 0 },
  eligibilityType: { type: String, enum: ['all', 'categories', 'products'], default: 'all' },
  eligibleCategories: { type: [String], default: [] },
  eligibleProductIds: { type: [String], default: [] },
  expiryDays: { type: Number, required: true, min: 1, default: 30 },
  maxRedemptions: { type: Number, required: true, min: 1, default: 1 },
  transferable: { type: Boolean, default: false },
  updatedBy: String,
}, { timestamps: true }));
const ScratchCard = mongoose.model('ScratchCard', new mongoose.Schema({
  scratchCardId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  eligibleOrderAmountPaise: { type: Number, required: true, min: 0 },
  rewardValuePaise: { type: Number, required: true, min: 1 },
  rewardType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  discountPurchaseId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['issued', 'scratched', 'redeemed', 'reversed'], default: 'issued', index: true },
  createdAt: { type: Date, default: Date.now },
  revealedAt: Date,
}, { timestamps: true }));
ScratchCard.schema.index({ userId: 1, createdAt: -1 });
const Invoice = mongoose.model('Invoice', new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true, index: true },
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  paymentId: String,
  paymentMethod: { type: String, required: true },
  customerName: String,
  customerEmail: String,
  billingAddress: mongoose.Schema.Types.Mixed,
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
  subtotalPaise: { type: Number, required: true, min: 0 },
  discountAmountPaise: { type: Number, default: 0, min: 0 },
  subscriptionDiscountAmountPaise: { type: Number, default: 0, min: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },
  discountCode: String,
  serviceChargePaise: { type: Number, default: 0, min: 0 },
  shippingPaise: { type: Number, default: 0, min: 0 },
  taxPaise: { type: Number, default: 0, min: 0 },
  totalPaise: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['Paid', 'Refunded', 'Partial Refund'], default: 'Paid' },
  pdfData: { type: Buffer, select: false },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const CreditNote = mongoose.model('CreditNote', new mongoose.Schema({
  creditNoteNumber: { type: String, required: true, unique: true, index: true },
  invoiceId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, index: true },
  refundCaseId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  amountPaise: { type: Number, required: true, min: 1 },
  reason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true }));
const Wishlist = mongoose.model('Wishlist', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  productId: { type: String, required: true },
  productType: { type: String, enum: ['product', 'promo', 'discount-code'], required: true },
  addedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
Wishlist.schema.index({ userId: 1, productType: 1, productId: 1 }, { unique: true });
const WalletTransferSchema = new mongoose.Schema({
  transferId: { type: String, required: true, unique: true },
  senderUserId: { type: String, required: true, index: true },
  senderWalletId: { type: String, required: true },
  receiverUserId: { type: String, required: true, index: true },
  receiverWalletId: { type: String, required: true },
  senderName: { type: String, default: '' },
  receiverName: { type: String, default: '' },
  remarks: { type: String, default: '', maxlength: 120 },
  amountPaise: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  status: { type: String, enum: ['COMPLETED'], required: true },
  idempotencyKey: { type: String, required: true },
  senderBalanceAfterPaise: { type: Number, required: true },
  receiverBalanceAfterPaise: { type: Number, required: true },
  completedAt: { type: Date, required: true },
}, { timestamps: true });
WalletTransferSchema.index({ senderUserId: 1, idempotencyKey: 1 }, { unique: true });
const WalletTransfer = mongoose.model('WalletTransfer', WalletTransferSchema);
const WalletPaymentRequest = mongoose.model('WalletPaymentRequest', new mongoose.Schema({
  requestId: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true },
  activeCheckoutKey: { type: String, select: false },
  checkoutReference: { type: String, required: true, index: true },
  requesterUserId: { type: String, required: true, index: true },
  payerUserId: { type: String, required: true, index: true },
  payerWalletId: { type: String, required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['Pending', 'Processing', 'Approved', 'Rejected', 'Cancelled', 'Expired'], default: 'Pending', index: true },
  paymentStatus: { type: String, enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'], default: 'PENDING', index: true },
  statusHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  paymentReference: { type: String, unique: true, sparse: true },
  orderId: { type: String, unique: true, sparse: true },
  approvedAt: Date,
  rejectedAt: Date,
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true }));
WalletPaymentRequest.schema.index({ payerUserId: 1, status: 1, createdAt: -1 });
WalletPaymentRequest.schema.index({ activeCheckoutKey: 1 }, { unique: true, sparse: true });
const SubscriptionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  durationMonths: { type: Number, min: 1, max: maxSubscriptionDurationMonths, default: 1 },
  monthlyPricePaise: { type: Number, min: 0 },
  previousPlan: { type: String, enum: Object.keys(planConfig), default: null },
  effectivePlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  pricePaise: { type: Number, required: true, min: 0 },
  startDate: { type: Date, required: true },
  expiryDate: { type: Date, required: true, index: true },
  expiredAt: Date,
  graceStartedAt: Date,
  graceEndsAt: Date,
  billAllowancePeriodStart: Date,
  autoRenew: { type: Boolean, default: true },
  status: { type: String, enum: ['active', 'expired', 'renewal_failed'], default: 'active', index: true },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  paymentReference: { type: String, required: true },
  cashbackGranted: { type: Boolean, default: false },
  renewalHistory: [{ date: Date, status: String, paymentReference: String, amountPaise: Number }],
}, { timestamps: true });
SubscriptionSchema.index({ userId: 1, status: 1, expiryDate: -1 });
SubscriptionSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
const Subscription = mongoose.model('Subscription', SubscriptionSchema);
const SubscriptionGraceDismissal = mongoose.model('SubscriptionGraceDismissal', new mongoose.Schema({
  userId: { type: String, required: true },
  gracePeriodId: { type: String, required: true },
  subscriptionId: { type: String, required: true },
  graceStartedAt: { type: Date, required: true },
  dismissalCount: { type: Number, min: 0, max: 2, default: 0 },
}, { timestamps: true }));
SubscriptionGraceDismissal.schema.index({ userId: 1, gracePeriodId: 1 }, { unique: true });
const AICredits = mongoose.model('AICredits', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  balance: { type: Number, required: true, min: 0, default: 0 },
  includedCredits: { type: Number, required: true, min: 0, default: 0 },
  purchasedCredits: { type: Number, required: true, min: 0, default: 0 },
  usedCredits: { type: Number, required: true, min: 0, default: 0 },
  includedCreditsRemaining: { type: Number, required: true, min: 0, default: 0 },
  purchasedCreditsRemaining: { type: Number, required: true, min: 0, default: 0 },
  creditBucketsInitialized: { type: Boolean, default: false },
  includedBills: { type: Number, required: true, min: 0, default: 0 },
  purchasedBills: { type: Number, required: true, min: 0, default: 0 },
  usedBills: { type: Number, required: true, min: 0, default: 0 },
  lastBillAllowancePeriod: { type: String, default: '' },
}, { timestamps: true }));
const AIBillPurchaseSchema = new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderCategory: { type: String, enum: ['PART_ORDER', 'SUBSCRIPTION_ORDER'], default: 'SUBSCRIPTION_ORDER', index: true },
  quantity: { type: Number, required: true, min: 1 },
  baseAmountPaise: { type: Number, min: 0, default: 0 },
  totalAmountPaise: { type: Number, required: true, min: 1 },
  subscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  paymentReference: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'cancelled'], default: 'pending', index: true },
  walletTransactionId: String,
  razorpayOrderId: String,
  razorpayOrderCreationStartedAt: Date,
  razorpayPaymentId: String,
  idempotencyKey: { type: String },
  creditsDeducted: { type: Number, min: 0, default: 0 },
}, { timestamps: true });
AIBillPurchaseSchema.index({ userId: 1, idempotencyKey: 1 }, {
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
});
AIBillPurchaseSchema.index({ razorpayPaymentId: 1 }, {
  unique: true,
  partialFilterExpression: { razorpayPaymentId: { $type: 'string' } },
});
const AIBillPurchase = mongoose.model('AIBillPurchase', AIBillPurchaseSchema);
const AIBillTransaction = mongoose.model('AIBillTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['allowance', 'purchase', 'used'], required: true },
  quantity: { type: Number, required: true, min: 0 },
  reference: { type: String, required: true, unique: true },
  periodKey: String,
  source: String,
  includedRemaining: { type: Number, min: 0 },
  purchasedRemaining: { type: Number, min: 0 },
  purchaseId: String,
  buildId: String,
}, { timestamps: true }));
const AICreditTransaction = mongoose.model('AICreditTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  type: { type: String, enum: ['added', 'used', 'expired'], required: true },
  amount: { type: Number, required: true, min: 1 },
  action: { type: String, required: true },
  reference: { type: String, required: true, unique: true },
  purchaseId: { type: String, index: true },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  amountPaise: { type: Number, min: 0 },
  previousBalance: { type: Number, min: 0 },
  balanceAfter: { type: Number, required: true, min: 0 },
}, { timestamps: true }));
const CreditPurchaseSchema = new mongoose.Schema({
  purchaseId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  orderCategory: { type: String, enum: ['PART_ORDER', 'SUBSCRIPTION_ORDER'], default: 'SUBSCRIPTION_ORDER', index: true },
  idempotencyKey: { type: String },
  credits: { type: Number, required: true, min: 1 },
  pricePerCreditPaise: { type: Number, required: true, min: 1 },
  baseAmountPaise: { type: Number, min: 0, default: 0 },
  totalAmountPaise: { type: Number, required: true, min: 1 },
  subscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  authorizedPlan: { type: String, enum: ['Exclusive'] },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'pending', index: true },
  walletTransactionId: String,
  razorpayOrderId: String,
  razorpayOrderCreationStartedAt: Date,
  razorpayPaymentId: String,
  previousBalance: { type: Number, min: 0 },
  newBalance: { type: Number, min: 0 },
  completedAt: Date,
}, { timestamps: true });
CreditPurchaseSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
CreditPurchaseSchema.index({ razorpayPaymentId: 1 }, { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
const CreditPurchase = mongoose.model('CreditPurchase', CreditPurchaseSchema);
CreditPurchase.schema.index({ userId: 1, createdAt: -1 });
const AIUsage = mongoose.model('AIUsage', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  action: { type: String, enum: ['chat', 'search', 'purchase'], required: true },
  creditCost: { type: Number, required: true, min: 0 },
}, { timestamps: true }));
const AITrial = mongoose.model('AITrial', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  plan: { type: String, enum: ['Premium', 'Exclusive'], required: true },
  status: { type: String, enum: ['active', 'expired'], required: true, default: 'active', index: true },
  activatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  expirationWarningShownAt: Date,
  buildLimit: { type: Number, required: true, min: 1, default: 2 },
  successfulBuilds: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true }));
const AIProjectQuota = mongoose.model('AIProjectQuota', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  quotaKey: { type: String, required: true },
  buildLimit: { type: Number, min: 1, default: null },
  successfulBuilds: { type: Number, required: true, min: 0, default: 0 },
  pendingBuilds: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true }));
AIProjectQuota.schema.index({ userId: 1, quotaKey: 1 }, { unique: true });
const AIProjectBuild = mongoose.model('AIProjectBuild', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  quotaKey: { type: String, required: true },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  status: { type: String, enum: ['generating', 'succeeded', 'failed'], required: true, index: true },
  result: mongoose.Schema.Types.Mixed,
}, { timestamps: true }));
AIProjectBuild.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
AIProjectBuild.schema.index({ userId: 1, createdAt: -1 });
const AIComponentCartAction = mongoose.model('AIComponentCartAction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true }));
AIComponentCartAction.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
const UserCart = mongoose.model('UserCart', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  items: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true }));
const removeOrderedItemsFromCart = async (session, userId, orderedItems) => {
  const cart = await UserCart.findOne({ userId }).session(session);
  if (!cart) return [];
  const quantitiesById = new Map();
  for (const item of orderedItems || []) {
    const id = String(item.id || '');
    const quantity = Number(item.quantity) || 0;
    if (id && quantity > 0) quantitiesById.set(id, (quantitiesById.get(id) || 0) + quantity);
  }
  let changed = false;
  const items = [];
  for (const item of cart.items || []) {
    const id = String(item.id || '');
    const remainingToRemove = quantitiesById.get(id) || 0;
    if (!remainingToRemove) {
      items.push(item.toObject ? item.toObject() : item);
      continue;
    }
    const currentQuantity = Number(item.quantity) || 0;
    const removedQuantity = Math.min(currentQuantity, remainingToRemove);
    const nextQuantity = currentQuantity - removedQuantity;
    quantitiesById.set(id, remainingToRemove - removedQuantity);
    changed = changed || removedQuantity > 0;
    if (nextQuantity > 0) items.push({ ...(item.toObject ? item.toObject() : item), quantity: nextQuantity });
  }
  if (changed) {
    cart.items = items;
    await cart.save({ session });
  }
  return items;
};
const ProductBrowsingHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  pricePaise: { type: Number, min: 0 },
  viewedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });
ProductBrowsingHistorySchema.index({ userId: 1, productId: 1 }, { unique: true });
ProductBrowsingHistorySchema.index({ userId: 1, viewedAt: -1 });
const ProductBrowsingHistory = mongoose.model('ProductBrowsingHistory', ProductBrowsingHistorySchema);
const ProductSearchHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  term: { type: String, required: true, trim: true, maxlength: 100 },
  normalizedTerm: { type: String, required: true },
  deduplicationKey: { type: String },
  searchedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, autoIndex: false });
ProductSearchHistorySchema.index({ userId: 1, searchedAt: -1 });
ProductSearchHistorySchema.index(
  { userId: 1, deduplicationKey: 1 },
  { unique: true, partialFilterExpression: { deduplicationKey: { $type: 'string' } }, name: 'product_search_user_dedup_unique' },
);
const ProductSearchHistory = mongoose.model('ProductSearchHistory', ProductSearchHistorySchema);
const PromotionState = mongoose.model('PromotionState', new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  shownAt: { type: [Date], default: [] },
  lastShownAt: Date,
}, { timestamps: true }));
const SubscriptionTransaction = mongoose.model('SubscriptionTransaction', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  orderCategory: { type: String, enum: ['PART_ORDER', 'SUBSCRIPTION_ORDER'], default: 'SUBSCRIPTION_ORDER', index: true },
  transactionType: { type: String, enum: ['purchase', 'renewal', 'upgrade'], default: 'purchase' },
  plan: { type: String, enum: Object.keys(planConfig), required: true },
  amountPaise: { type: Number, required: true, min: 0 },
  creditsAllocated: { type: Number, min: 0, default: 0 },
  billsAllocated: { type: Number, min: 0, default: 0 },
  durationMonths: { type: Number, min: 1, max: maxSubscriptionDurationMonths, default: 1 },
  monthlyPricePaise: { type: Number, min: 0 },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  orderId: { type: String, index: true },
  startDate: Date,
  expiryDate: Date,
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  paymentReference: { type: String, required: true, unique: true },
  cashbackPaise: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['Successful', 'Failed'], default: 'Successful' },
}, { timestamps: true }));
const PlanPayment = mongoose.model('PlanPayment', new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  orderCategory: { type: String, enum: ['PART_ORDER', 'SUBSCRIPTION_ORDER'], default: 'SUBSCRIPTION_ORDER', index: true },
  plan: { type: String, enum: ['Medium', 'Premium', 'Exclusive'], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  durationMonths: { type: Number, min: 1, max: maxSubscriptionDurationMonths, default: 1 },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
  paymentId: String,
}, { timestamps: true }));
const PromoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, match: /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/ },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['unused', 'reserved', 'pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed', 'deactivated'], default: 'unused', index: true },
  createdBy: { type: String, required: true },
  validitySeconds: { type: Number, min: 60, default: 30 * 24 * 60 * 60 },
  maxUses: { type: Number, min: 1, max: 1000, default: 10 },
  successfulUses: { type: Number, min: 0, default: 0 },
  activatedAt: Date,
  expiresAt: Date,
  reservationId: String,
  reservationKey: String,
  reservationOwner: { userId: String },
  reservationExpiresAt: Date,
  purchaseType: { type: String, enum: ['online', 'offline'] },
  recipientType: { type: String, enum: ['myself', 'gift'], default: 'myself' },
  giftRecipientId: String,
  giftRecipientEmail: { type: String, lowercase: true, trim: true },
  giftBuyerId: String,
  giftBuyerName: String,
  giftBuyerEmail: { type: String, lowercase: true, trim: true },
  buyerAddress: mongoose.Schema.Types.Mixed,
  recipientAddress: mongoose.Schema.Types.Mixed,
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  purchaseIdempotencyKey: String,
  purchasePayableAmountPaise: { type: Number, min: 0 },
  purchaseSubscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  purchaseSubscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  purchaseSubscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  purchasedBy: { userId: String, name: String, email: String },
  purchasedAt: Date,
  orderId: String,
  usedBy: { userId: String, name: String, email: String },
  usedAt: Date,
}, { timestamps: true });
PromoCodeSchema.index({ reservationId: 1 }, { unique: true, sparse: true });
PromoCodeSchema.index({ 'reservationOwner.userId': 1, reservationKey: 1 }, { unique: true, sparse: true });
PromoCodeSchema.index({ purchaseIdempotencyKey: 1 }, { unique: true, sparse: true });
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);
const expirePromoCodes = async () => {
  const now = new Date();
  const expired = await PromoCode.find({ status: 'purchased', expiresAt: { $lte: now } }).select('_id orderId').lean();
  if (!expired.length) return 0;
  const ids = expired.map((promo) => promo._id);
  await PromoCode.updateMany({ _id: { $in: ids }, status: 'purchased', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
  const orderIds = expired.map((promo) => promo.orderId).filter(Boolean);
  if (orderIds.length) await Order.updateMany(
    { orderId: { $in: orderIds }, orderType: 'PROMO_CODE' },
    { $set: { promoActivationStatus: 'expired', promoCodeStatus: 'EXPIRED' } },
  );
  return expired.length;
};
const promoExpirySweep = setInterval(() => {
  if (mongoose.connection.readyState === 1) {
    expirePromoCodes().catch((error) => console.error('Promo expiry sweep failed:', error.name));
  }
}, 30_000);
promoExpirySweep.unref();
const refundStatuses = [
  'REFUND_PLACED', 'ORDER_CHECK_PENDING', 'ORDER_CHECKING', 'RETURN_REQUIRED',
  'PACKAGE_ARRIVED', 'PART_CHECKING', 'ORDER_ACCEPTED', 'ORDER_DECLINED',
  'REFUND_PROCESSING', 'REFUND_INITIATED', 'REFUND_CREDITED', 'REFUND_COMPLETED', 'REFUND_REJECTED',
];
const RefundSchema = new mongoose.Schema({
  refundCaseId: { type: String, required: true, unique: true },
  orderId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  originalPaymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  originalPaymentReference: String,
  verifiedAmountPaidPaise: { type: Number, min: 0 },
  refundDestination: { type: String, enum: ['Innovation Labs Wallet', 'Razorpay'] },
  refundProviderReference: String,
  refundIdempotencyKey: String,
  refundProviderStatus: String,
  refundDeductionsPaise: { type: Number, min: 0, default: 0 },
  cancellationSource: { type: String, enum: ['ADMIN', 'CUSTOMER'] },
  refundTransactionReferenceId: String,
  refundCreatedAt: Date,
  refundCompletedAt: Date,
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  originalOrderAmountPaise: { type: Number, min: 0 },
  calculatedRefundAmountPaise: { type: Number, min: 0 },
  approvedRefundAmountPaise: { type: Number, min: 0 },
  refundAmountPaise: { type: Number, required: true, min: 1 },
  itemsSnapshot: [{ id: String, name: String, category: String, price: Number, quantity: Number }],
  orderSnapshot: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: refundStatuses, default: 'REFUND_PLACED' },
  reason: { type: String, default: '' },
  reasonCategory: { type: String, default: 'Other' },
  evidence: {
    fileName: String,
    contentType: String,
    size: Number,
    data: { type: Buffer, select: false },
  },
  adminReason: { type: String, default: '' },
  walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  walletTransactionReferenceId: String,
  statusHistory: [{ status: String, changedBy: String, note: String, createdAt: Date }],
  adminAudit: [{ adminId: String, action: String, timestamp: Date, oldStatus: String, newStatus: String, amountPaise: Number, reason: String }],
}, { timestamps: true });
const Refund = mongoose.model('Refund', RefundSchema);

const frontendBuildPath = fileURLToPath(new URL('.', import.meta.url));
app.use(express.json({
  limit: '32kb',
  verify: (req, _res, buffer) => {
    if (req.originalUrl === '/api/webhooks/razorpay/inquiry-payments') req.rawBody = Buffer.from(buffer);
  },
}));
app.use(cookieParser());
app.use(express.static(frontendBuildPath, {
  index: false,
  fallthrough: true,
  redirect: false,
}));

const requireSession = (req, res, next) => {
  (async () => {
    let session;
    try {
      session = jwt.verify(req.cookies.innovation_session || '', sessionSecret);
    } catch {
      return res.sendStatus(401);
    }
    req.session = session;
    if (session.jti && revokedSessionIds.has(session.jti)) return res.sendStatus(401);
    if (!['/api/auth/me', '/api/account/age-verification', '/api/auth/logout'].includes(req.path)) {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Account access could not be verified because the database is unavailable.' });
      }
      try {
        if (session.jti && await RevokedSession.exists({ sessionId: session.jti })) return res.sendStatus(401);
        const account = await User.findOne({ googleId: session.sub })
          .select('accountStatus ageVerificationStatus').lean();
        if (!account) return res.sendStatus(401);
        if (account.accountStatus === 'restricted' || account.ageVerificationStatus === 'restricted') {
          return res.status(403).json({ code: 'ACCOUNT_RESTRICTED', message: 'This account is restricted from accessing Innovation Labs.' });
        }
        if (account.ageVerificationStatus !== 'verified') {
          return res.status(403).json({ code: 'AGE_VERIFICATION_REQUIRED', message: 'Verify your age before accessing Innovation Labs.' });
        }
      } catch (error) {
        console.error('Could not verify account access:', error.message);
        return res.status(503).json({ message: 'Your account status could not be verified right now.' });
      }
    } else if (session.jti && mongoose.connection.readyState === 1) {
      try {
        if (await RevokedSession.exists({ sessionId: session.jti })) return res.sendStatus(401);
      } catch (error) {
        console.error('Could not verify session revocation:', error.name);
        return res.status(503).json({ message: 'Your session could not be verified because the database is unavailable.' });
      }
    }
    return next();
  })();
};

const walletUnlockCookieName = 'innovation_wallet_unlock';
const walletUnlockCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 15 * 60 * 1000,
  path: '/api',
};

const issueWalletUnlock = (res, session) => {
  const token = jwt.sign({ sub: session.sub, sessionJti: session.jti, scope: 'wallet' }, sessionSecret, { expiresIn: '15m' });
  res.cookie(walletUnlockCookieName, token, walletUnlockCookieOptions);
};

const hasWalletUnlock = (req) => {
  try {
    const authorization = jwt.verify(req.cookies[walletUnlockCookieName] || '', sessionSecret);
    return authorization.scope === 'wallet'
      && authorization.sub === req.session.sub
      && authorization.sessionJti === req.session.jti;
  } catch {
    return false;
  }
};

const requireWalletUnlock = (req, res, next) => {
  if (!hasWalletUnlock(req)) {
    return res.status(423).json({ walletLocked: true, message: 'Verify your Wallet PIN to continue.' });
  }
  issueWalletUnlock(res, req.session);
  return next();
};

const inquiryVerifiedCookieName = 'innovation_inquiry_verified';
const issueInquiryVerification = (res, session, bookings) => {
  const bookingIds = bookings.map((booking) => String(booking._id));
  const expiresAt = Math.max(...bookings.map((booking) => new Date(booking.slotEnd).getTime()));
  const maxAge = Math.max(1000, expiresAt - Date.now());
  const token = jwt.sign({
    sub: session.sub,
    sessionJti: session.jti,
    scope: 'inquiry',
    bookingIds,
  }, sessionSecret, { expiresIn: Math.ceil(maxAge / 1000) });
  res.cookie(inquiryVerifiedCookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/api/inquiries',
  });
};
const hasInquiryVerification = (req, bookingId) => {
  try {
    const authorization = jwt.verify(req.cookies[inquiryVerifiedCookieName] || '', sessionSecret);
    return authorization.scope === 'inquiry'
      && authorization.sub === req.session.sub
      && authorization.sessionJti === req.session.jti
      && Array.isArray(authorization.bookingIds)
      && authorization.bookingIds.includes(String(bookingId));
  } catch {
    return false;
  }
};

const requireDatabase = (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    const messages = {
      authentication: 'Database authentication failed. Check the server MongoDB credentials.',
      dns: 'The database hostname could not be resolved.',
      timeout: 'The database connection timed out.',
      network: 'The database network connection was refused.',
      configuration: 'The server database configuration is missing or invalid.',
    };
    return res.status(503).json({
      message: messages[databaseDiagnostic.errorType] || 'Unable to connect to the database right now.',
      errorType: databaseDiagnostic.errorType || 'unavailable',
    });
  }
  return next();
};

const isPurchaseAgeEligible = (dateOfBirth, now = new Date()) => {
  if (!(dateOfBirth instanceof Date) || !Number.isFinite(dateOfBirth.getTime())) return false;
  const birthYear = dateOfBirth.getUTCFullYear();
  const birthMonth = dateOfBirth.getUTCMonth();
  const birthDay = dateOfBirth.getUTCDate();
  let age = now.getUTCFullYear() - birthYear;
  if (now.getUTCMonth() < birthMonth || (now.getUTCMonth() === birthMonth && now.getUTCDate() < birthDay)) age -= 1;
  return age >= 18;
};
const requirePurchaseAge = async (req, res, next) => {
  try {
    const user = await User.findOne({ googleId: req.session.sub }).select('dateOfBirth').lean();
    if (!user || !isPurchaseAgeEligible(user.dateOfBirth)) {
      return res.status(403).json({ code: 'PURCHASE_AGE_REQUIRED', message: 'Save a date of birth confirming you are at least 18 before making a purchase.' });
    }
    return next();
  } catch (error) {
    console.error('Purchase age eligibility could not be checked:', error.message);
    return res.status(503).json({ message: 'Purchase eligibility could not be verified right now.' });
  }
};

const classifyDatabaseError = (error) => {
  if (error?.code === 117) return 'operation-conflict';
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('auth') || message.includes('bad auth')) return 'authentication';
  if (message.includes('enotfound') || message.includes('querysrv') || message.includes('dns')) return 'dns';
  if (message.includes('timeout') || message.includes('server selection')) return 'timeout';
  if (message.includes('econnrefused') || message.includes('network') || message.includes('ip')) return 'network';
  if (message.includes('uri') || message.includes('connection string')) return 'configuration';
  return 'unknown';
};

const requireAdmin = (req, res, next) => {
  const verifiedAdmin = req.session.admin === true && adminEmail && String(req.session.email || '').trim().toLowerCase() === adminEmail;
  if (!verifiedAdmin) {
    return res.status(403).json({ message: 'Admin access is required.' });
  }
  return next();
};

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/admin/')
    || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || req.session?.admin !== true || !req.session.sub) return;
    AdminAuditLog.create({
      adminId: req.session.sub,
      action: `${req.method} ${req.path}`.slice(0, 240),
      route: req.path.slice(0, 240),
      responseStatus: res.statusCode,
    }).catch((error) => {
      console.error('Could not persist admin audit event:', error.name);
    });
  });
  return next();
});

const isAdminEmail = (email) => Boolean(adminEmail) && String(email || '').trim().toLowerCase() === adminEmail;

const createSessionCookie = (res, payload) => {
  const session = jwt.sign({ ...payload, jti: crypto.randomUUID() }, sessionSecret, { expiresIn: '7d' });
  res.cookie('innovation_session', session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const toPaise = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
};

const money = (paise) => Math.round(paise) / 100;

const hashPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPin = (pin, storedHash) => {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(pin, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
};

const validatePin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);
const normalizeWalletId = (value) => String(value || '').trim().toUpperCase();
const validateWalletId = (value) => /^@WL[A-Z]{4}\d{4}$/.test(value);
const safeRecipientName = (value) => String(value || 'Innovation Labs user').trim().replace(/\s+/g, ' ') || 'Innovation Labs user';

const writeSseEvent = (res, event, data = {}) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const broadcastSse = (event, data, userId = null) => {
  const clients = userId
    ? (sseUserClients.get(String(userId)) || [])
    : [...sseAdminClients];
  for (const client of clients) {
    try {
      writeSseEvent(client, event, data);
    } catch (error) {
      console.error('Could not broadcast SSE event:', error.message);
    }
  }
};

const broadcastOrderEvent = (order, event, extra = {}) => {
  if (!order?.userId) return;
  const data = {
    orderId: order.orderId,
    userId: order.userId,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    ...extra,
  };
  broadcastSse(event, data, order.userId);
  broadcastSse(event, data);
};

const findDeliveredAt = (order) => {
  const delivery = (order.statusHistory || [])
    .filter((entry) => ['Delivered', 'Completed'].includes(entry.status) && entry.createdAt)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
  return delivery ? new Date(delivery.createdAt) : null;
};

const estimatedDeliveryArrivalAt = (estimatedDelivery) => {
  const date = new Date(estimatedDelivery);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return new Date(Date.UTC(values.year, values.month - 1, values.day, 6, 30));
};

const orderHasArrived = (order, now = new Date()) => {
  if (['Delivered', 'Completed'].includes(order.orderStatus)) return true;
  const arrivalAt = estimatedDeliveryArrivalAt(order.estimatedDelivery);
  return Boolean(arrivalAt && now >= arrivalAt);
};

const refundEligibilityFor = (order, existingRefund = null, now = new Date()) => {
  if (existingRefund) return { eligible: false, reason: 'A refund case already exists for this order.', refund: existingRefund };
  if (order.orderType === 'PROMO_CODE') return { eligible: false, reason: 'Digital Promo Code purchases are non-refundable.', deliveredAt: null };
  if (order.paymentMethod !== 'Wallet') return { eligible: false, reason: 'Wallet refunds are available only for orders paid using Wallet.' };
  if (order.orderStatus === 'Cancelled' || order.cancellationId) return { eligible: false, reason: 'This order has been cancelled.' };
  if (!['Delivered', 'Completed'].includes(order.orderStatus)) {
    return { eligible: false, reason: 'The order must be delivered before requesting a refund.', deliveredAt: null };
  }
  const deliveredAt = findDeliveredAt(order);
  if (!deliveredAt) return { eligible: false, reason: 'The delivery date is not available yet.', deliveredAt: null };
  const eligibleAt = new Date(deliveredAt.getTime() + refundEligibilityDays * 24 * 60 * 60 * 1000);
  if (now < eligibleAt) {
    return { eligible: false, reason: `Refund requests open ${refundEligibilityDays} days after delivery.`, deliveredAt, eligibleAt };
  }
  return { eligible: true, reason: '', deliveredAt, eligibleAt };
};

const cancellationEligibilityFor = (order, hasUnusedDiscountCodePurchases = false, now = new Date()) => {
  if (order.orderType === 'PROMO_CODE') return { eligible: false, reason: 'Digital Promo Code purchases cannot be cancelled or refunded.' };
  if (order.orderType === 'DISCOUNT_CODE' && !hasUnusedDiscountCodePurchases) return { eligible: false, reason: 'This Discount Promo Code is not available for cancellation.' };
  if (order.paymentMethod !== 'Wallet') return { eligible: false, reason: 'Only Wallet-paid orders can use wallet cancellation.' };
  if (order.paymentStatus !== 'Paid') return { eligible: false, reason: 'Only paid orders can be cancelled.' };
  const cancellableStatus = order.orderType === 'DISCOUNT_CODE'
    ? ['Processing', 'Confirmed'].includes(order.orderStatus)
    : order.orderStatus === 'Processing';
  if (!cancellableStatus || order.acceptedAt || (order.statusHistory || []).some((entry) => entry.status === 'Accepted')) {
    return { eligible: false, reason: 'Orders can only be cancelled before admin acceptance.' };
  }
  if (order.cancelledAt || order.orderStatus === 'Cancelled') return { eligible: false, reason: 'This order has already been cancelled.' };
  if (orderHasArrived(order, now)) return { eligible: false, reason: 'An order cannot be cancelled after its estimated arrival time.' };
  if (order.refundCaseId) return { eligible: false, reason: 'This order already has a refund case.' };
  const eligibleItems = (order.items || []).map((item, itemIndex) => ({
    itemIndex,
    item,
    remainingQuantity: Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)),
  })).filter(({ item, remainingQuantity }) => item.cancellable !== false && remainingQuantity > 0);
  if (!eligibleItems.length) return { eligible: false, reason: 'No cancellable products remain in this order.' };
  return { eligible: true, reason: '', eligibleItems: eligibleItems.map(({ itemIndex, item, remainingQuantity }) => ({
    itemIndex,
    name: item.name,
    quantity: Number(item.quantity || 0),
    cancelledQuantity: Number(item.cancelledQuantity || 0),
    remainingQuantity,
    cancellable: item.cancellable !== false,
  })) };
};

const orderDiscountCodePurchasesAreUnused = (order, purchases) => {
  if (order.orderType !== 'DISCOUNT_CODE') return false;
  const expectedCount = (order.items || []).reduce((sum, item) =>
    sum + (item.discountOfferId ? Number(item.quantity || 0) : 0), 0);
  return expectedCount > 0
    && purchases.length === expectedCount
    && purchases.every((purchase) =>
      purchase.fulfillmentStatus === 'fulfilled' && purchase.redemptionCount === 0 && purchase.offerId);
};

const refundEvidenceUpload = (req, res, next) => uploadRefundEvidence.single('evidence')(req, res, (error) => {
  if (!error) return next();
  return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.message || 'Evidence upload failed.' });
});

const identifyRefundImage = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const planSettingKey = (planName, field) => `subscription_plan_${planName.toLowerCase()}_${field}`;
const loadSubscriptionPlanSettings = async () => {
  const settings = await AdminSetting.find({
    key: { $in: Object.entries(planConfig).flatMap(([planName]) => ['pricePaise', 'walletLimitPaise', 'cashbackPaise'].map((field) => planSettingKey(planName, field))) },
  }).lean();
  const byKey = new Map(settings.map((setting) => [setting.key, Number(setting.value)]));
  for (const [planName, config] of Object.entries(planConfig)) {
    for (const field of ['pricePaise', 'walletLimitPaise', 'cashbackPaise']) {
      const value = byKey.get(planSettingKey(planName, field));
      if (Number.isSafeInteger(value) && value >= 0) config[field] = value;
    }
  }
  for (const [planName, config] of Object.entries(planConfig)) walletLimitByPlan[planName] = config.walletLimitPaise;
};
const getPlanWalletLimit = (planName) => walletLimitByPlan[String(planName || 'Starter')] || walletLimitByPlan.Starter || 500000;
const getConfiguredGraceHours = async () => {
  return 48;
};
const getSubscriptionGraceState = async (userId, session = null) => {
  const now = new Date();
  const active = await currentSubscription(userId, session);
  if (active) {
    return {
      active,
      effectivePlan: active.plan,
      previousPlan: active.plan,
      graceActive: false,
      graceStartedAt: null,
      graceEndsAt: null,
      gracePeriodId: null,
      remainingGraceMs: 0,
      previousPlanName: active.plan,
    };
  }
  const latestExpiredSubscription = await Subscription.findOne({
    userId,
    status: { $in: ['expired', 'renewal_failed'] },
    expiryDate: { $lte: now },
  }).sort({ expiryDate: -1 }).session(session || null).lean();
  if (!latestExpiredSubscription) {
    return {
      active: null,
      effectivePlan: 'Starter',
      previousPlan: 'Starter',
      graceActive: false,
      graceStartedAt: null,
      graceEndsAt: null,
      gracePeriodId: null,
      remainingGraceMs: 0,
      previousPlanName: 'Starter',
    };
  }
  const graceHours = await getConfiguredGraceHours();
  const graceStartedAt = latestExpiredSubscription.expiryDate;
  if (!graceStartedAt) {
    throw new Error(`Expired subscription ${latestExpiredSubscription._id} has no saved expiry or grace start timestamp.`);
  }
  const graceEndsAt = new Date(graceStartedAt.getTime() + graceHours * 60 * 60 * 1000);
  if (!latestExpiredSubscription.graceStartedAt
    || latestExpiredSubscription.graceStartedAt.getTime() !== graceStartedAt.getTime()
    || !latestExpiredSubscription.graceEndsAt
    || latestExpiredSubscription.graceEndsAt.getTime() !== graceEndsAt.getTime()) {
    const updated = await Subscription.updateOne(
      { _id: latestExpiredSubscription._id, status: latestExpiredSubscription.status, expiryDate: latestExpiredSubscription.expiryDate },
      { $set: { graceStartedAt, graceEndsAt, expiredAt: latestExpiredSubscription.expiredAt || graceStartedAt } },
      { session: session || undefined },
    );
    if (!updated.matchedCount) {
      throw new Error(`Grace period timestamps for subscription ${latestExpiredSubscription._id} could not be persisted.`);
    }
  }
  const graceActive = graceEndsAt > now;
  return {
    active: null,
    effectivePlan: 'Starter',
    previousPlan: latestExpiredSubscription.previousPlan || latestExpiredSubscription.plan || 'Starter',
    graceActive,
    graceStartedAt,
    graceEndsAt,
    gracePeriodId: `${latestExpiredSubscription._id}:${graceStartedAt.getTime()}`,
    remainingGraceMs: graceActive ? Math.max(0, graceEndsAt.getTime() - now.getTime()) : 0,
    previousPlanName: latestExpiredSubscription.previousPlan || latestExpiredSubscription.plan || 'Starter',
    expiryDate: latestExpiredSubscription.expiryDate,
  };
};
const getActivePlanName = async (userId, session = null) => {
  const active = await currentSubscription(userId, session);
  if (active) return active.plan;
  const graceState = await getSubscriptionGraceState(userId, session);
  return graceState.effectivePlan || 'Starter';
};
const getWalletBalanceState = async (userId, session = null) => {
  const wallet = await Wallet.findOne({ userId }).session(session || null).lean();
  if (wallet && Number.isSafeInteger(wallet.balancePaise) && wallet.balancePaise >= 0) {
    return { wallet, balancePaise: wallet.balancePaise, balanceKnown: true, ledgerFallback: false };
  }
  const latestTransaction = await WalletTransaction.findOne({
    userId,
    status: { $in: ['Successful', 'Completed'] },
  }).sort({ createdAt: -1, _id: -1 }).select('balanceAfterPaise').session(session || null).lean();
  if (latestTransaction && (!Number.isSafeInteger(latestTransaction.balanceAfterPaise) || latestTransaction.balanceAfterPaise < 0)) {
    throw new Error(`Wallet ledger for user ${userId} has an invalid balance snapshot.`);
  }
  if (wallet && !latestTransaction) {
    throw new Error(`Wallet ${wallet._id} has no valid balance field or ledger snapshot.`);
  }
  return {
    wallet,
    balancePaise: latestTransaction ? latestTransaction.balanceAfterPaise : 0,
    balanceKnown: Boolean(latestTransaction),
    ledgerFallback: Boolean(latestTransaction),
  };
};
const getWalletLimitStatus = async (userId, walletBalancePaise = 0, session = null) => {
  const planName = await getActivePlanName(userId, session);
  const graceState = await getSubscriptionGraceState(userId, session);
  const maxPaise = getPlanWalletLimit(planName);
  const balance = Number(walletBalancePaise || 0);
  const amountAboveLimitPaise = balance > maxPaise ? balance - maxPaise : 0;
  const persistedWallet = !graceState.active && !graceState.graceActive
    ? await Wallet.findOne({ userId }).select('restrictedBalancePaise balanceRestrictionActive effectivePlan graceEndsAt').session(session || null).lean()
    : null;
  const persistedLockApplies = Boolean(
    persistedWallet?.balanceRestrictionActive
    && persistedWallet.effectivePlan === planName
    && new Date(persistedWallet.graceEndsAt || 0).getTime() === new Date(graceState.graceEndsAt).getTime(),
  );
  const restrictedBalancePaise = graceState.graceActive
    ? 0
    : persistedLockApplies
      ? Math.min(balance, Math.max(amountAboveLimitPaise, Number(persistedWallet.restrictedBalancePaise || 0)))
      : amountAboveLimitPaise;
  const availableBalancePaise = balance - restrictedBalancePaise;
  const availableDepositCapacityPaise = Math.max(0, maxPaise - balance);
  return {
    plan: planName,
    previousPlan: graceState.previousPlan || planName,
    previousPlanName: graceState.previousPlanName || graceState.previousPlan || planName,
    maximumBalancePaise: maxPaise,
    maximumBalance: money(maxPaise),
    availableBalancePaise,
    availableBalance: money(availableBalancePaise),
    restrictedBalancePaise,
    restrictedBalance: money(restrictedBalancePaise),
    availableDepositCapacityPaise,
    availableDepositCapacity: money(availableDepositCapacityPaise),
    isAboveLimit: balance > maxPaise,
    amountAboveLimitPaise,
    restrictionActive: restrictedBalancePaise > 0,
    remainingToLimit: Math.max(0, maxPaise - balance),
    grace: graceState.graceActive ? {
      previousPlan: graceState.previousPlan,
      currentPlan: 'Starter',
      startedAt: graceState.graceStartedAt,
      endsAt: graceState.graceEndsAt,
      gracePeriodId: graceState.gracePeriodId,
      remainingMs: graceState.remainingGraceMs,
      active: true,
      amountAboveLimitPaise,
      lockedBalancePaise: 0,
    } : {
      previousPlan: graceState.previousPlan,
      currentPlan: 'Starter',
      startedAt: graceState.graceStartedAt,
      endsAt: graceState.graceEndsAt,
      gracePeriodId: graceState.gracePeriodId,
      remainingMs: 0,
      active: false,
      amountAboveLimitPaise,
      lockedBalancePaise: restrictedBalancePaise,
    },
  };
};
const walletAvailableBalancePaise = (wallet) =>
  Math.max(0, Number(wallet?.balancePaise || 0) - Number(wallet?.restrictedBalancePaise || 0));
const walletView = (wallet, transactions = [], planState = null) => ({
  balance: money(planState?.availableBalancePaise ?? walletAvailableBalancePaise(wallet)),
  availableBalance: money(planState?.availableBalancePaise ?? walletAvailableBalancePaise(wallet)),
  totalBalance: money(wallet.balancePaise),
  totalBalancePaise: Number(wallet.balancePaise || 0),
  availableBalancePaise: Number(planState?.availableBalancePaise ?? walletAvailableBalancePaise(wallet)),
  hasPin: Boolean(wallet.pinHash),
  walletId: wallet.walletId || null,
  restrictedBalance: money(planState?.restrictedBalancePaise ?? wallet.restrictedBalancePaise ?? 0),
  restrictedBalancePaise: Number(planState?.restrictedBalancePaise ?? wallet.restrictedBalancePaise ?? 0),
  ...(planState ? {
    plan: planState.plan,
    previousPlan: planState.previousPlan || planState.plan,
    maximumBalance: planState.maximumBalance,
    maximumBalancePaise: planState.maximumBalancePaise,
    availableBalance: planState.availableBalance,
    availableBalancePaise: planState.availableBalancePaise,
    availableDepositCapacity: planState.availableDepositCapacity,
    availableDepositCapacityPaise: planState.availableDepositCapacityPaise,
    restrictedBalanceCurrent: planState.restrictedBalance,
    restrictedBalancePaiseCurrent: planState.restrictedBalancePaise,
    amountAboveLimit: money(planState.amountAboveLimitPaise),
    amountAboveLimitPaise: planState.amountAboveLimitPaise,
    balanceRestrictionActive: planState.restrictionActive,
    isAboveLimit: planState.isAboveLimit,
    grace: planState.grace || null,
  } : {}),
  transactions: transactions.map((transaction) => ({
    id: transaction._id,
    type: transaction.type,
    amount: money(transaction.amountPaise),
    balanceAfter: money(transaction.availableBalanceAfterPaise ?? transaction.balanceAfterPaise),
    referenceId: transaction.referenceId,
    orderId: transaction.orderId || null,
    refundCaseId: transaction.refundCaseId || null,
    originalPaymentMethod: transaction.originalPaymentMethod || null,
    originalPaymentReference: transaction.originalPaymentReference || null,
    refundDestination: transaction.refundDestination || null,
    transferId: transaction.transferId || null,
    peerWalletId: transaction.peerWalletId || null,
    description: displayPlanText(transaction.description),
    status: transaction.status,
    createdAt: transaction.createdAt,
  })),
});

const enforceAvailableWalletSpendLimit = (currentBalancePaise, amountPaise, limitState, label = 'Wallet balance') => {
  const availableBalancePaise = Math.max(0, Number(limitState.availableBalancePaise ?? currentBalancePaise));
  if (amountPaise > availableBalancePaise) {
    const restrictedBalancePaise = Math.max(0, currentBalancePaise - availableBalancePaise);
    return {
      allowed: false,
      availableBalancePaise,
      restrictedBalancePaise,
      message: `Your ${label} includes ₹${money(availableBalancePaise)} currently available. ₹${money(restrictedBalancePaise)} is locked after your ${displayPlanName(limitState.previousPlan || limitState.plan)} subscription expired.`,
    };
  }
  return { allowed: true, availableBalancePaise, restrictedBalancePaise: Math.max(0, currentBalancePaise - availableBalancePaise) };
};
const assertWalletSpendAvailable = async (userId, wallet, amountPaise, session = null, label = 'Wallet balance') => {
  const limitState = await getWalletLimitStatus(userId, wallet.balancePaise, session);
  const spendCheck = enforceAvailableWalletSpendLimit(wallet.balancePaise, amountPaise, limitState, label);
  if (!spendCheck.allowed) {
    throw Object.assign(new Error(spendCheck.message), {
      status: 409,
      availableBalance: money(spendCheck.availableBalancePaise),
      restrictedBalance: money(spendCheck.restrictedBalancePaise),
    });
  }
  return limitState;
};
const syncWalletRestrictionState = async (userId, session = null, balanceOverride = null) => {
  if (!session) return withMongoTransaction((transactionSession) =>
    syncWalletRestrictionState(userId, transactionSession, balanceOverride));
  const wallet = await Wallet.findOne({ userId }).session(session || null);
  if (!wallet) return null;
  const balancePaise = balanceOverride ?? wallet.balancePaise;
  const limitState = await getWalletLimitStatus(userId, balancePaise, session);
  const previousRestrictedBalancePaise = Math.min(
    balancePaise,
    Math.max(0, Number(wallet.restrictedBalancePaise || 0)),
  );
  const sameRestrictionContext = wallet.balanceRestrictionActive
    && wallet.effectivePlan === limitState.plan
    && new Date(wallet.graceEndsAt || 0).getTime() === new Date(limitState.grace?.endsAt || 0).getTime();
  const restrictedBalancePaise = limitState.grace?.active
    ? 0
    : sameRestrictionContext
      ? Math.min(balancePaise, Math.max(limitState.amountAboveLimitPaise, Number(wallet.restrictedBalancePaise || 0)))
      : limitState.amountAboveLimitPaise;
  const graceStartedAt = limitState.grace?.startedAt ? new Date(limitState.grace.startedAt) : null;
  const graceEndsAt = limitState.grace?.endsAt ? new Date(limitState.grace.endsAt) : null;
  const restrictionActive = restrictedBalancePaise > 0;
  const gracePeriodId = limitState.grace?.gracePeriodId || null;
  const restrictionStateKey = JSON.stringify({
    plan: limitState.plan,
    previousPlan: limitState.previousPlan || limitState.plan,
    restrictedBalancePaise,
    gracePeriodId,
    graceStartedAt: graceStartedAt?.toISOString() || null,
    graceEndsAt: graceEndsAt?.toISOString() || null,
    restrictionActive,
  });
  const legacyRestrictions = await WalletTransaction.find({
    userId,
    type: 'Adjustment',
    amountPaise: { $gt: 0 },
    description: /(?:wallet balance )?restricted after the .* subscription grace period/i,
  }).session(session);
  for (const transaction of legacyRestrictions) {
    transaction.type = 'Wallet Restriction';
    transaction.amountPaise = -Math.abs(transaction.amountPaise);
    transaction.description = 'Excess wallet balance restricted after subscription grace period.';
    transaction.availableBalanceAfterPaise = Math.max(0, transaction.balanceBeforePaise - Math.abs(transaction.amountPaise));
    await transaction.save({ session });
  }
  const changed = wallet.restrictionStateKey !== restrictionStateKey
    || previousRestrictedBalancePaise !== restrictedBalancePaise;
  const restrictionDeltaPaise = restrictedBalancePaise - previousRestrictedBalancePaise;
  if (restrictionDeltaPaise !== 0) {
    const transitionReference = crypto.createHash('sha256')
      .update(`${wallet.restrictionStateKey || 'unrestricted'}:${restrictionStateKey}:${restrictionDeltaPaise}`)
      .digest('hex');
    const isRestriction = restrictionDeltaPaise > 0;
    const referenceId = `${isRestriction ? 'wallet-restriction' : 'wallet-restriction-reversal'}:${userId}:${gracePeriodId || 'plan-limit'}:${transitionReference}`;
    const availableAfterPaise = Math.max(0, balancePaise - restrictedBalancePaise);
    await WalletTransaction.updateOne(
      { referenceId },
      { $setOnInsert: {
        userId,
        type: isRestriction ? 'Wallet Restriction' : 'Wallet Restriction Reversal',
        amountPaise: -restrictionDeltaPaise,
        balanceBeforePaise: balancePaise,
        balanceAfterPaise: balancePaise,
        availableBalanceAfterPaise: availableAfterPaise,
        referenceId,
        description: isRestriction
          ? 'Excess wallet balance restricted after subscription grace period.'
          : 'Restricted wallet balance restored after subscription upgrade.',
        status: 'Successful',
      } },
      { upsert: true, session },
    );
  }
  wallet.restrictedBalancePaise = restrictedBalancePaise;
  wallet.totalBalancePaise = balancePaise;
  wallet.availableBalancePaise = Math.max(0, balancePaise - restrictedBalancePaise);
  wallet.effectivePlan = limitState.plan;
  wallet.previousPlan = limitState.previousPlan || limitState.plan;
  wallet.graceStartedAt = graceStartedAt;
  wallet.graceEndsAt = graceEndsAt;
  wallet.balanceRestrictionActive = restrictionActive;
  wallet.lockAppliedAt = restrictionActive ? (wallet.lockAppliedAt || new Date()) : null;
  wallet.restrictionStateKey = restrictionStateKey;
  if (changed || wallet.isModified()) await wallet.save({ session });
  return wallet.toObject();
};

const setRefundStatus = (refund, status, changedBy, note = '', action = 'status_changed') => {
  const oldStatus = refund.status;
  const timestamp = new Date();
  refund.status = status;
  refund.statusHistory.push({ status, changedBy, note, createdAt: timestamp });
  refund.adminAudit.push({
    adminId: changedBy,
    action,
    timestamp,
    oldStatus,
    newStatus: status,
    amountPaise: refund.approvedRefundAmountPaise ?? refund.refundAmountPaise,
    reason: note,
  });
};

const withMongoTransaction = async (callback) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await callback(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const modelInitialization = new Map();
const ensureMongoCollections = async (models) => {
  for (const model of models) {
    let initialization = modelInitialization.get(model);
    if (!initialization) {
      initialization = model.init();
      modelInitialization.set(model, initialization);
      initialization.catch(() => modelInitialization.delete(model));
    }
    await initialization;
  }
};

const defaultRewardRules = {
  minimumEligibleAmountPaise: 10000,
  firstTierMaximumPaise: 100000,
  firstTierPoints: 5,
  higherTierPoints: 20,
};

const rewardRulesFor = async (session) => await RewardRule.findOne({ key: 'default' }).session(session).lean() || defaultRewardRules;

const pointsForEligibleAmount = (eligibleAmountPaise, rules) => {
  if (eligibleAmountPaise <= rules.minimumEligibleAmountPaise) return 0;
  return eligibleAmountPaise <= rules.firstTierMaximumPaise ? rules.firstTierPoints : rules.higherTierPoints;
};

const eligibleOrderAmountPaise = (order) => {
  if (order.orderType === 'PROMO_CODE') return Math.max(0, Number(order.promoCodeAmountPaise || 0));
  if (order.orderType !== 'PRODUCT') return 0;
  const eligible = (order.items || []).reduce((total, item) => {
    if (/plan|membership|subscription|service|delivery|ai credit/i.test(`${item.category || ''} ${item.name || ''}`)) return total;
    const itemAmount = toPaise(item.price) * Number(item.quantity || 0);
    return Number.isSafeInteger(itemAmount) && itemAmount > 0 ? total + itemAmount : total;
  }, 0);
  return Math.max(0, eligible - Number(order.discountAmountPaise || 0));
};

const awardRewardPointsForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || ['Cancelled', 'Declined', 'Rejected', 'Failed'].includes(order.orderStatus)) return null;
  const eligibleAmountPaise = eligibleOrderAmountPaise(order);
  const rules = await rewardRulesFor(session);
  const points = pointsForEligibleAmount(eligibleAmountPaise, rules);
  if (!Number.isSafeInteger(points) || points <= 0 || !order.orderId || !order.userId) return null;
  const transactionId = `earn:${order.orderId}`;
  const existingTransaction = await RewardTransaction.findOne({ transactionId }).session(session).lean();
  if (existingTransaction) {
    order.rewardPointsEarned = existingTransaction.points;
    await Order.updateOne({ orderId: order.orderId, userId: order.userId }, { $set: { rewardPointsEarned: existingTransaction.points } }, { session });
    return existingTransaction.points;
  }
  await RewardAccount.findOneAndUpdate(
    { userId: order.userId },
    { $setOnInsert: { userId: order.userId }, $inc: { availablePoints: points, lifetimePointsEarned: points } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );
  const productType = order.orderType === 'PROMO_CODE' ? 'Promo Code' : 'Physical Parts';
  await RewardTransaction.create([{
    transactionId,
    userId: order.userId,
    userEmail: order.userEmail,
    orderId: order.orderId,
    transactionType: 'earned',
    productType,
    eligibleAmountPaise,
    points,
    walletAmountPaise: 0,
    status: 'earned',
  }], { session });
  order.rewardPointsEarned = points;
  await Order.updateOne({ orderId: order.orderId, userId: order.userId }, { $set: { rewardPointsEarned: points } }, { session });
  return points;
};

const reverseRewardPointsForOrder = async (session, order, { referenceId, refundAmountPaise }) => {
  if (!order?.orderId || !order.userId || !referenceId) return 0;
  const earned = await RewardTransaction.findOne({ userId: order.userId, orderId: order.orderId, transactionType: 'earned' }).session(session).lean();
  if (!earned) return 0;
  const transactionId = `reverse:${referenceId}`;
  if (await RewardTransaction.exists({ transactionId }).session(session)) return 0;
  const eligibleRefundPaise = Math.min(earned.eligibleAmountPaise, Math.max(0, Number(refundAmountPaise) || 0));
  if (!eligibleRefundPaise || !earned.eligibleAmountPaise) return 0;
  const points = eligibleRefundPaise >= earned.eligibleAmountPaise
    ? earned.points
    : Math.floor(earned.points * eligibleRefundPaise / earned.eligibleAmountPaise);
  if (!points) return 0;
  await RewardAccount.updateOne(
    { userId: order.userId },
    { $inc: { availablePoints: -points } },
    { session },
  );
  await RewardTransaction.create([{
    transactionId,
    userId: order.userId,
    userEmail: order.userEmail,
    orderId: order.orderId,
    transactionType: 'reversed',
    productType: earned.productType,
    eligibleAmountPaise: eligibleRefundPaise,
    points,
    walletAmountPaise: 0,
    status: 'reversed',
  }], { session });
  return points;
};

const invoiceCurrency = (paise) => `INR ${money(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const renderTransferReceiptPdf = async ({ transfer, sender, receiver, senderWalletId, receiverWalletId }) => {
  let logo;
  try {
    logo = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'Innovation Labs logo.png'));
  } catch (error) {
    throw new Error(`Innovation Labs logo could not be loaded: ${error.message}`);
  }
  return new Promise((resolve, reject) => {
  const document = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks = [];
  document.on('data', (chunk) => chunks.push(chunk));
  document.on('error', reject);
  document.on('end', () => resolve(Buffer.concat(chunks)));
  const moneyText = (paise) => `₹${money(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const detail = (label, value, x, y, width = 220) => {
    document.font('Helvetica-Bold').fontSize(8).fillColor('#6a7f87').text(label.toUpperCase(), x, y);
    document.font('Helvetica').fontSize(10).fillColor('#16313b').text(value || '—', x, y + 13, { width });
  };
  document.rect(0, 0, 612, 132).fill('#071b24');
  document.image(logo, 48, 30, { fit: [70, 70] });
  document.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff').text('INNOVATION LABS', 132, 43);
  document.font('Helvetica').fontSize(9).fillColor('#73e6f4').text('SECURE WALLET PAYMENTS', 134, 73);
  document.font('Helvetica-Bold').fontSize(22).fillColor('#16313b').text('PAYMENT RECEIPT', 48, 166);
  document.roundedRect(400, 157, 164, 34, 8).fill('#e4f8ef');
  document.font('Helvetica-Bold').fontSize(10).fillColor('#24735e').text('✓  PAYMENT SUCCESSFUL', 412, 169);
  document.roundedRect(48, 219, 516, 100, 10).fill('#f0f8fa');
  document.font('Helvetica').fontSize(9).fillColor('#5b747c').text('AMOUNT PAID', 70, 241);
  document.font('Helvetica-Bold').fontSize(28).fillColor('#0b5363').text(moneyText(transfer.amountPaise), 70, 258);
  detail('Payment method', 'Innovation Labs Wallet', 350, 241, 190);
  detail('Transaction date', new Date(transfer.completedAt).toLocaleString('en-IN'), 350, 280, 190);
  document.moveTo(48, 350).lineTo(564, 350).strokeColor('#cbd8dc').stroke();
  document.font('Helvetica-Bold').fontSize(11).fillColor('#16313b').text('TRANSACTION DETAILS', 48, 370);
  detail('Transaction ID', transfer.transferId, 48, 400, 240);
  detail('Status', 'Successful', 320, 400, 220);
  detail('Description', transfer.remarks || 'Personal Innovation Labs Wallet transfer', 48, 452, 516);
  document.font('Helvetica-Bold').fontSize(11).fillColor('#16313b').text('SENDER', 48, 520);
  document.font('Helvetica-Bold').fontSize(11).fillColor('#16313b').text('RECIPIENT', 320, 520);
  detail('Name', sender.name, 48, 548, 220);
  detail('Registered account', sender.email, 48, 588, 220);
  detail('Wallet ID', senderWalletId, 48, 628, 220);
  detail('Name', receiver.name, 320, 548, 220);
  detail('Registered account', receiver.email, 320, 588, 220);
  detail('Wallet ID', receiverWalletId, 320, 628, 220);
  document.moveTo(48, 704).lineTo(564, 704).strokeColor('#cbd8dc').stroke();
  document.font('Helvetica').fontSize(8).fillColor('#6a7f87').text('This is a digitally generated transaction receipt from Innovation Labs.', 48, 723, { width: 516, align: 'center' });
  document.text('Please retain this receipt for your records.', 48, 738, { width: 516, align: 'center' });
    document.end();
  });
};

const renderInvoicePdf = (invoice) => new Promise((resolve, reject) => {
  const document = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const chunks = [];
  document.on('data', (chunk) => chunks.push(chunk));
  document.on('error', reject);
  document.on('end', () => resolve(Buffer.concat(chunks)));
  const right = (text, y, options = {}) => document.font('Helvetica').fontSize(9).fillColor('#47616b').text(text, 320, y, { width: 225, align: 'right', ...options });
  document.rect(0, 0, 612, 128).fill('#071b24');
  document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('INNOVATION LABS', 48, 43);
  document.fillColor('#73e6f4').font('Helvetica').fontSize(9).text('TECHNOLOGY FOR IDEAS IN MOTION', 50, 76);
  if (process.env.COMPANY_ADDRESS) document.fillColor('#bfd2d8').fontSize(8).text(process.env.COMPANY_ADDRESS, 50, 96, { width: 330 });
  if (process.env.SUPPORT_EMAIL) document.fillColor('#bfd2d8').fontSize(8).text(process.env.SUPPORT_EMAIL, 50, 109);
  document.fillColor('#0b2029').font('Helvetica-Bold').fontSize(20).text('INVOICE', 48, 152);
  right(`Invoice ${invoice.invoiceNumber}`, 155);
  right(`Date ${new Date(invoice.createdAt).toLocaleDateString('en-IN')}`, 171);
  right(`Order ${invoice.orderId}`, 187);
  right(`Payment method ${invoice.paymentMethod}`, 203);
  right(`Transaction ${invoice.paymentId || '—'}`, 219, { ellipsis: true });
  document.moveTo(48, 232).lineTo(564, 232).strokeColor('#cbd8dc').stroke();
  document.fillColor('#0b2029').font('Helvetica-Bold').fontSize(10).text('BILLED TO', 48, 250);
  document.font('Helvetica').fontSize(9).fillColor('#304b56').text(invoice.customerName || 'Customer', 48, 268);
  document.text(invoice.customerEmail || '', 48, 282);
  const address = invoice.billingAddress || {};
  const addressText = [address.fullName, address.phoneNumber, address.addressLine1, address.addressLine2, address.city, address.state, address.pinCode, address.country].filter(Boolean).join(', ');
  if (addressText) document.text(addressText, 48, 296, { width: 300, height: 42 });
  let y = 355;
  document.rect(48, y, 516, 25).fill('#eaf5f7');
  document.fillColor('#20444f').font('Helvetica-Bold').fontSize(8).text('ITEM', 57, y + 8);
  document.text('TYPE', 308, y + 8);
  document.text('QTY', 410, y + 8, { width: 40, align: 'right' });
  document.text('UNIT', 455, y + 8, { width: 48, align: 'right' });
  document.text('TOTAL', 508, y + 8, { width: 48, align: 'right' });
  y += 25;
  for (const item of invoice.items || []) {
    const line = toPaise(item.price || 0) * Number(item.quantity || 1);
    document.fillColor('#273f49').font('Helvetica').fontSize(8).text(String(item.name || 'Product'), 57, y + 9, { width: 240, ellipsis: true });
    document.text(String(item.category || item.productType || 'Product'), 308, y + 9, { width: 90, ellipsis: true });
    document.text(String(item.quantity || 1), 410, y + 9, { width: 40, align: 'right' });
    document.text(invoiceCurrency(toPaise(item.price || 0)), 452, y + 9, { width: 52, align: 'right' });
    document.text(invoiceCurrency(line), 507, y + 9, { width: 49, align: 'right' });
    y += 31;
    if (y > 650) { document.addPage(); y = 55; }
  }
  y += 8;
  document.moveTo(340, y).lineTo(564, y).strokeColor('#cbd8dc').stroke();
  y += 14;
  const totals = [
    ['Subtotal', invoice.subtotalPaise],
    ...(invoice.discountAmountPaise ? [[`Discount${invoice.discountCode ? ` (${invoice.discountCode})` : ''}`, -invoice.discountAmountPaise]] : []),
    ...(invoice.subscriptionDiscountAmountPaise ? [[`${displayPlanName(invoice.subscriptionDiscountPlan)} subscription discount (${invoice.subscriptionDiscountPercent}% off)`, -invoice.subscriptionDiscountAmountPaise]] : []),
    ...(invoice.serviceChargePaise ? [['Service charges', invoice.serviceChargePaise]] : []),
    ['Shipping', invoice.shippingPaise],
    ...(invoice.taxPaise ? [['Tax', invoice.taxPaise]] : []),
  ];
  for (const [label, value] of totals) {
    document.font('Helvetica').fontSize(9).fillColor('#47616b').text(label, 348, y, { width: 105 });
    document.text(`${Number(value) < 0 ? '−' : ''}${invoiceCurrency(Math.abs(value))}`, 453, y, { width: 103, align: 'right' });
    y += 17;
  }
  document.font('Helvetica-Bold').fontSize(11).fillColor('#0b2029').text('Total paid', 348, y + 2, { width: 105 });
  document.text(invoiceCurrency(invoice.totalPaise), 453, y + 2, { width: 103, align: 'right' });
  y += 30;
  document.rect(348, y, 216, 25).fill('#e5f8f2');
  const paymentLabel = invoice.paymentStatus === 'Paid' ? 'PAYMENT SUCCESSFUL' : `PAYMENT ${invoice.paymentStatus.toUpperCase()}`;
  document.fillColor('#24735e').font('Helvetica-Bold').fontSize(9).text(paymentLabel, 360, y + 8);
  document.fillColor('#637b84').font('Helvetica').fontSize(9).text('Thank you for shopping with Innovation Labs!', 48, 744, { width: 516, align: 'center' });
  document.end();
});

const createInvoiceForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || !order.orderId) return null;
  const existing = await Invoice.findOne({ orderId: order.orderId }).session(session).lean();
  if (existing) return existing;
  const walletPayment = ['Wallet', 'Wallet QR'].includes(order.paymentMethod)
    ? await WalletTransaction.findOne({ orderId: order.orderId, type: 'Purchase', status: 'Successful' }).session(session).select('referenceId').lean()
    : null;
  const invoice = {
    invoiceId: `INV-${crypto.randomUUID()}`,
    invoiceNumber: `IL-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    userId: order.userId,
    orderId: order.orderId,
    paymentId: order.razorpayId || walletPayment?.referenceId || (order.promoReservationId ? `promo-purchase:${order.promoReservationId}` : ''),
    paymentMethod: order.paymentMethod,
    customerName: order.userName,
    customerEmail: order.userEmail,
    billingAddress: order.buyerAddress || order.address || null,
    items: (order.items || []).map((item) => ({ name: item.name, category: item.category, quantity: item.quantity, price: item.price })),
    subtotalPaise: toPaise(order.subtotal || 0),
    discountAmountPaise: Number(order.discountAmountPaise || 0),
    discountCode: order.discountCode || '',
    subscriptionDiscountAmountPaise: Number(order.subscriptionDiscountAmountPaise || 0),
    subscriptionDiscountPlan: order.subscriptionDiscountPlan || 'Starter',
    subscriptionDiscountPercent: Number(order.subscriptionDiscountPercent || 0),
    serviceChargePaise: toPaise(order.codingCharge || 0) + toPaise(order.buildingCharge || 0),
    shippingPaise: toPaise(order.deliveryCharge || 0),
    taxPaise: 0,
    totalPaise: toPaise(order.total || 0),
    paymentStatus: 'Paid',
    createdAt: order.createdAt || new Date(),
  };
  invoice.pdfData = await renderInvoicePdf(invoice);
  const [created] = await Invoice.create([invoice], { session });
  return created.toObject();
};

const createInvoiceForStandalonePurchase = async (session, {
  userId,
  orderId,
  paymentId,
  paymentMethod,
  itemName,
  amountPaise,
  baseAmountPaise = amountPaise,
  subscriptionDiscountAmountPaise = 0,
  subscriptionDiscountPlan = 'Starter',
  subscriptionDiscountPercent = 0,
}) => {
  const existing = await Invoice.findOne({ orderId }).session(session).lean();
  if (existing) return existing;
  const user = await User.findOne({ googleId: userId }).session(session).lean();
  const invoice = {
    invoiceId: `INV-${crypto.randomUUID()}`,
    invoiceNumber: `IL-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    userId,
    orderId,
    paymentId,
    paymentMethod,
    customerName: user?.name || 'Innovation Labs customer',
    customerEmail: user?.email || '',
    billingAddress: user?.address || null,
    items: [{ name: itemName, category: 'Digital Purchase', quantity: 1, price: money(baseAmountPaise) }],
    subtotalPaise: baseAmountPaise,
    discountAmountPaise: 0,
    subscriptionDiscountAmountPaise,
    subscriptionDiscountPlan,
    subscriptionDiscountPercent,
    shippingPaise: 0,
    taxPaise: 0,
    totalPaise: amountPaise,
    paymentStatus: 'Paid',
    createdAt: new Date(),
  };
  invoice.pdfData = await renderInvoicePdf(invoice);
  const [created] = await Invoice.create([invoice], { session });
  return created.toObject();
};

const createCreditNoteForRefund = async (session, { userId, orderId, refundCaseId, amountPaise, reason = '' }) => {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return null;
  const existing = await CreditNote.findOne({ refundCaseId }).session(session).lean();
  if (existing) return existing;
  const invoice = await Invoice.findOne({ userId, orderId }).session(session).lean();
  if (!invoice) return null;
  const [creditNote] = await CreditNote.create([{
    creditNoteNumber: `IL-CN-${new Date().getFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    invoiceId: invoice.invoiceId,
    orderId,
    refundCaseId,
    userId,
    amountPaise,
    reason: String(reason).slice(0, 500),
  }], { session });
  return creditNote.toObject();
};

const releaseDiscountRedemptionForOrder = async (session, orderId) => {
  const redemption = await DiscountRedemption.findOne({ orderId, status: 'redeemed' }).session(session);
  if (redemption) {
    redemption.status = 'refunded';
    await redemption.save({ session });
    await DiscountCodeUsage.updateOne({ code: redemption.code, userId: redemption.userId, redemptionCount: { $gt: 0 } }, { $inc: { redemptionCount: -1 } }, { session });
    const purchase = await PurchasedDiscountCode.findOneAndUpdate(
      { purchaseId: redemption.purchaseId, redemptionCount: { $gt: 0 } },
      { $inc: { redemptionCount: -1 } },
      { new: true, session },
    ).select('isScratchReward scratchCardId redemptionCount maxRedemptions').lean();
    if (purchase?.isScratchReward) {
      await ScratchCard.updateOne(
        { scratchCardId: purchase.scratchCardId, status: { $in: ['scratched', 'redeemed'] } },
        { $set: { status: purchase.redemptionCount >= purchase.maxRedemptions ? 'redeemed' : 'scratched' } },
        { session },
      );
    }
    if (redemption.offerId) await DiscountCodeOffer.updateOne({ _id: redemption.offerId, redeemedCount: { $gt: 0 } }, { $inc: { redeemedCount: -1 } }, { session });
  }
  const scratch = await ScratchCard.findOne({ orderId }).session(session);
  if (scratch && scratch.status !== 'reversed') {
    scratch.status = 'reversed';
    await scratch.save({ session });
    await PurchasedDiscountCode.updateOne({ purchaseId: scratch.discountPurchaseId }, { $set: { fulfillmentStatus: 'rejected' } }, { session });
  }
  return redemption?.toObject() || null;
};

const discountItemIsEligible = (item, eligibility = {}) => {
  if (/plan|membership|subscription|wallet|promo code|discount code|service|delivery|ai credit/i.test(`${item.category || ''} ${item.name || ''}`)) return false;
  if (eligibility.eligibilityType === 'categories' && !(eligibility.eligibleCategories || []).includes(item.category)) return false;
  if (eligibility.eligibilityType === 'products' && !(eligibility.eligibleProductIds || []).includes(item.id || item.productId)) return false;
  return true;
};

const scratchEligibleAmountPaise = (order, settings) => {
  if (!order || order.orderType !== 'PRODUCT') return 0;
  const eligibleItemsPaise = (order.items || []).reduce((sum, item) => {
    if (!discountItemIsEligible(item, settings)) return sum;
    const amount = toPaise(item.price) * Number(item.quantity || 0);
    return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
  return Math.max(0, eligibleItemsPaise - Number(order.discountAmountPaise || 0));
};

const generateUniqueDiscountCode = async (session) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''));
    const code = groups.join('-');
    const [offer, purchase] = await Promise.all([
      DiscountCodeOffer.exists({ code }).session(session),
      PurchasedDiscountCode.exists({ code }).session(session),
    ]);
    const [registered, walletCode] = await Promise.all([
      DiscountCodeRegistry.exists({ code }).session(session),
      PromoCode.exists({ code }).session(session),
    ]);
    if (!offer && !purchase && !registered && !walletCode) return code;
  }
  throw Object.assign(new Error('A unique Discount Promo Code could not be generated.'), { status: 409 });
};

const defaultScratchSettings = {
  enabled: true,
  thresholdPaise: 500000,
  rewardValuesPaise: [5000, 10000, 20000, 50000],
  discountType: 'fixed',
  minimumPurchasePaise: 0,
  eligibilityType: 'all',
  eligibleCategories: [],
  eligibleProductIds: [],
  expiryDays: 30,
  maxRedemptions: 1,
  transferable: false,
};

const createOrReserveRewardOffer = async (session, {
  rewardValue,
  discountType,
  expiresAt,
  minimumPurchasePaise,
  eligibilityType,
  eligibleCategories,
  eligibleProductIds,
  maxRedemptions,
}) => {
  const now = new Date();
  const offerFilter = {
    discountType,
    active: true,
    startsAt: { $lte: now },
    expiresAt: { $gt: now },
    availableQuantity: { $gt: 0 },
    purchasedCount: 0,
    minimumPurchasePaise,
    eligibilityType,
    eligibleCategories,
    eligibleProductIds,
    ...(discountType === 'fixed' ? { discountValuePaise: rewardValue } : { discountPercent: rewardValue }),
  };
  let offer = await DiscountCodeOffer.findOneAndUpdate(
    offerFilter,
    { $inc: { availableQuantity: -1, purchasedCount: 1 } },
    { new: true, session, sort: { createdAt: 1 } },
  );
  if (!offer) {
    const code = await generateUniqueDiscountCode(session);
    const [createdOffer] = await DiscountCodeOffer.create([{
      code,
      name: discountType === 'fixed' ? `₹${money(rewardValue)} Discount Promo Code` : `${money(rewardValue)}% Discount Promo Code`,
      source: 'SCRATCH_CARD',
      sellingPricePaise: 0,
      discountType,
      discountValuePaise: discountType === 'fixed' ? rewardValue : 0,
      discountPercent: discountType === 'percentage' ? money(rewardValue) : 0,
      startsAt: now,
      expiresAt,
      maxRedemptions,
      maxRedemptionsPerCustomer: maxRedemptions,
      availableQuantity: 1,
      purchasedCount: 0,
      redeemedCount: 0,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories,
      eligibleProductIds,
      active: true,
    }], { session });
    await DiscountCodeRegistry.create([{
      code,
      sourceType: 'offer',
      sourceId: String(createdOffer._id),
    }], { session });
    offer = await DiscountCodeOffer.findOneAndUpdate(
      { _id: createdOffer._id, availableQuantity: { $gt: 0 } },
      { $inc: { availableQuantity: -1, purchasedCount: 1 } },
      { new: true, session },
    );
  }
  if (!offer) throw Object.assign(new Error('No discount promo code could be reserved for this reward.'), { status: 409 });
  return offer;
};

const createScratchCardReward = async (session, {
  userId,
  orderId,
  eligibleOrderAmountPaise,
  rewardValue,
  rewardType,
  settings,
  order,
}) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.expiryDays * 24 * 60 * 60 * 1000);
  const offer = await createOrReserveRewardOffer(session, {
    rewardValue,
    discountType: rewardType,
    expiresAt,
    minimumPurchasePaise: settings.minimumPurchasePaise || 0,
    eligibilityType: settings.eligibilityType || 'all',
    eligibleCategories: settings.eligibleCategories || [],
    eligibleProductIds: settings.eligibleProductIds || [],
    maxRedemptions: settings.maxRedemptions || 1,
  });
  const scratchCardId = `SC-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const purchaseId = `SCR-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const purchaseExpiresAt = new Date(Math.min(offer.expiresAt.getTime(), expiresAt.getTime()));
  await PurchasedDiscountCode.create([{
    purchaseId,
    offerId: offer._id,
    code: offer.code,
    userId,
    purchaserUserId: userId,
    orderId: orderId || `REWARD-${purchaseId}`,
    sellingPricePaise: 0,
    discountType: offer.discountType,
    discountValuePaise: offer.discountValuePaise,
    discountPercent: offer.discountPercent,
    minimumPurchasePaise: offer.minimumPurchasePaise,
    eligibilityType: offer.eligibilityType,
    eligibleCategories: offer.eligibleCategories,
    eligibleProductIds: offer.eligibleProductIds,
    maxRedemptions: settings.maxRedemptions || 1,
    maxRedemptionsPerCustomer: settings.maxRedemptions || 1,
    redemptionCount: 0,
    purchasedAt: now,
    expiresAt: purchaseExpiresAt,
    fulfillmentStatus: 'pending',
    isScratchReward: true,
    scratchCardId,
    transferable: settings.transferable,
    source: 'SCRATCH_CARD',
  }], { session });
  const [scratchCard] = await ScratchCard.create([{
    scratchCardId,
    userId,
    orderId: orderId || `REWARD-${purchaseId}`,
    eligibleOrderAmountPaise,
    rewardValuePaise: rewardValue,
    rewardType,
    discountPurchaseId: purchaseId,
    status: 'issued',
    createdAt: now,
  }], { session });
  if (order) {
    order.scratchCardId = scratchCardId;
    await order.save({ session });
  }
  await Notification.create([{
    userId,
    type: 'scratch_card_awarded',
    data: { scratchCardId, orderId },
    message: "Congratulations! You've unlocked a Scratch Card!",
  }], { session });
  return scratchCard.toObject();
};

const createScratchCardForOrder = async (session, order) => {
  if (!order || order.paymentStatus !== 'Paid' || !order.orderId || order.orderType !== 'PRODUCT') return null;
  if (await ScratchCard.exists({ orderId: order.orderId }).session(session)) return null;
  const settings = await ScratchSettings.findOne({ key: 'default' }).session(session).lean() || defaultScratchSettings;
  const eligibleOrderAmountPaise = scratchEligibleAmountPaise(order, settings);
  if (!settings.enabled || eligibleOrderAmountPaise <= settings.thresholdPaise) return null;
  const rewardValues = (settings.rewardValuesPaise || []).filter((amount) => Number.isSafeInteger(amount) && amount > 0);
  if (!rewardValues.length) return null;
  const rewardValue = rewardValues[crypto.randomInt(rewardValues.length)];
  return createScratchCardReward(session, {
    userId: order.userId,
    orderId: order.orderId,
    eligibleOrderAmountPaise,
    rewardValue,
    rewardType: settings.discountType || 'fixed',
    settings,
    order,
  });
};

const discountEligibleAmountPaise = (items, eligibility) => (items || []).reduce((sum, item) => {
  if (!discountItemIsEligible(item, eligibility)) return sum;
  const amount = toPaise(item.price) * Number(item.quantity || 0);
  return Number.isSafeInteger(amount) && amount > 0 ? sum + amount : sum;
}, 0);

const discountCodeContext = async ({ session, userId, code, items }) => {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(normalizedCode)) {
    let walletPromoQuery = PromoCode.findOne({ code: normalizedCode });
    if (session) walletPromoQuery = walletPromoQuery.session(session);
    if (await walletPromoQuery.select('_id').lean()) throw Object.assign(new Error('This is a Wallet Promo Code. It cannot be used for product discounts.'), { status: 400, code: 'WALLET_PROMO_NOT_DISCOUNT' });
    throw Object.assign(new Error('Invalid promo code. Please check your code and try again.'), { status: 400, code: 'DISCOUNT_INVALID' });
  }
  let offerQuery = DiscountCodeOffer.findOne({ code: normalizedCode });
  if (session) offerQuery = offerQuery.session(session);
  const offer = await offerQuery.lean();
  if (!offer) {
    let walletPromoQuery = PromoCode.findOne({ code: normalizedCode });
    if (session) walletPromoQuery = walletPromoQuery.session(session);
    if (await walletPromoQuery.select('_id').lean()) throw Object.assign(new Error('This is a Wallet Promo Code. It cannot be used for product discounts.'), { status: 400, code: 'WALLET_PROMO_NOT_DISCOUNT' });
  }
  const now = new Date();
  if (offer && (!offer.active || offer.startsAt > now || offer.expiresAt <= now)) {
    throw Object.assign(new Error('This promo code has expired.'), { status: 409, code: 'DISCOUNT_EXPIRED' });
  }
  if (offer && offer.redeemedCount >= offer.maxRedemptions) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  let purchasesQuery = PurchasedDiscountCode.find({
    userId,
    code: normalizedCode,
    fulfillmentStatus: 'fulfilled',
    expiresAt: { $gt: now },
    $expr: { $lt: ['$redemptionCount', '$maxRedemptions'] },
  }).sort({ purchasedAt: 1 });
  if (session) purchasesQuery = purchasesQuery.session(session);
  const purchase = await purchasesQuery.lean();
  if (!purchase.length) {
    let expiredQuery = PurchasedDiscountCode.findOne({ userId, code: normalizedCode, fulfillmentStatus: 'fulfilled', expiresAt: { $lte: now } });
    if (session) expiredQuery = expiredQuery.session(session);
    if (await expiredQuery.select('_id').lean()) throw Object.assign(new Error('This promo code has expired.'), { status: 410, code: 'DISCOUNT_EXPIRED' });
    let pendingQuery = PurchasedDiscountCode.findOne({ userId, code: normalizedCode, fulfillmentStatus: 'pending' });
    if (session) pendingQuery = pendingQuery.session(session);
    if (await pendingQuery.select('_id').lean()) throw Object.assign(new Error('This promo code is not fulfilled yet.'), { status: 409, code: 'DISCOUNT_NOT_FULFILLED' });
    let redeemedQuery = DiscountCodeUsage.findOne({ code: normalizedCode, userId });
    if (session) redeemedQuery = redeemedQuery.session(session);
    const usage = await redeemedQuery.lean();
    const perCustomerLimit = offer?.maxRedemptionsPerCustomer || 1;
    if (usage && usage.redemptionCount >= perCustomerLimit) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
    throw Object.assign(new Error('Invalid promo code. Please check your code and try again.'), { status: 400, code: 'DISCOUNT_INVALID' });
  }
  const selectedPurchase = purchase[0];
  const perCustomerLimit = Math.min(offer?.maxRedemptionsPerCustomer || selectedPurchase.maxRedemptionsPerCustomer, selectedPurchase.maxRedemptionsPerCustomer);
  let usageQuery = DiscountCodeUsage.findOne({ code: normalizedCode, userId });
  if (session) usageQuery = usageQuery.session(session);
  const usage = await usageQuery.lean();
  if ((usage?.redemptionCount || 0) >= perCustomerLimit) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  const eligibility = selectedPurchase;
  const eligibleAmountPaise = discountEligibleAmountPaise(items, eligibility);
  const minimumPurchasePaise = Math.max(offer?.minimumPurchasePaise || 0, selectedPurchase.minimumPurchasePaise || 0);
  if (eligibleAmountPaise <= 0) throw Object.assign(new Error('Add eligible products to your cart before applying a discount code.'), { status: 409, code: 'DISCOUNT_NO_ELIGIBLE_ITEMS' });
  if (eligibleAmountPaise < minimumPurchasePaise) throw Object.assign(new Error(`This promo code requires at least ₹${money(minimumPurchasePaise).toLocaleString('en-IN')} in eligible products.`), { status: 409, code: 'DISCOUNT_MINIMUM' });
  const discountType = selectedPurchase.discountType;
  const calculated = discountType === 'percentage'
    ? Math.round(eligibleAmountPaise * selectedPurchase.discountPercent / 100)
    : selectedPurchase.discountValuePaise;
  const discountAmountPaise = Math.max(0, Math.min(eligibleAmountPaise, calculated));
  if (!discountAmountPaise) throw Object.assign(new Error('This promo code does not apply a discount to these products.'), { status: 409, code: 'DISCOUNT_NOT_APPLICABLE' });
  return { offer, purchase: selectedPurchase, code: normalizedCode, eligibleAmountPaise, discountAmountPaise };
};

const redeemDiscountCode = async (session, { userId, code, items, orderId }) => {
  const context = await discountCodeContext({ session, userId, code, items });
  const now = new Date();
  const usageLimit = Math.min(context.offer?.maxRedemptionsPerCustomer || context.purchase.maxRedemptionsPerCustomer, context.purchase.maxRedemptionsPerCustomer);
  try {
    await DiscountCodeUsage.findOneAndUpdate(
      { code: context.code, userId, redemptionCount: { $lt: usageLimit } },
      { $setOnInsert: { code: context.code, userId }, $inc: { redemptionCount: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );
  } catch (error) {
    if (error.code === 11000) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
    throw error;
  }
  const updatedPurchase = await PurchasedDiscountCode.findOneAndUpdate(
    { _id: context.purchase._id, fulfillmentStatus: 'fulfilled', expiresAt: { $gt: now }, redemptionCount: { $lt: context.purchase.maxRedemptions } },
    { $inc: { redemptionCount: 1 } },
    { new: true, session },
  );
  if (!updatedPurchase) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  if (context.offer) {
    const offerUpdate = await DiscountCodeOffer.updateOne(
      { _id: context.offer._id, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, redeemedCount: { $lt: context.offer.maxRedemptions } },
      { $inc: { redeemedCount: 1 } },
      { session },
    );
    if (!offerUpdate.modifiedCount) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'DISCOUNT_USED' });
  }
  const redemptionId = `DR-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  await DiscountRedemption.create([{
    redemptionId,
    purchaseId: context.purchase.purchaseId,
    offerId: context.offer?._id || null,
    code: context.code,
    userId,
    orderId,
    discountAmountPaise: context.discountAmountPaise,
    status: 'redeemed',
    redeemedAt: now,
  }], { session });
  if (context.purchase.isScratchReward) {
    const scratchCard = await ScratchCard.findOne({
      scratchCardId: context.purchase.scratchCardId,
      userId,
      status: { $in: ['scratched', 'redeemed'] },
    }).session(session);
    if (!scratchCard) throw Object.assign(new Error('The Scratch Card reward is no longer available.'), { status: 409, code: 'DISCOUNT_USED' });
    scratchCard.status = updatedPurchase.redemptionCount >= updatedPurchase.maxRedemptions ? 'redeemed' : 'scratched';
    await scratchCard.save({ session });
  }
  return context;
};

const resolveDiscountRecipient = async (session, buyerUserId, buyerEmail, recipientEmail) => {
  const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail === String(buyerEmail).toLowerCase()) return { userId: buyerUserId, email: buyerEmail, gift: false };
  const recipient = await User.findOne({ email: normalizedEmail }).select('googleId email').session(session).lean();
  if (!recipient) throw Object.assign(new Error('The gift recipient must have a registered Innovation Labs account.'), { status: 404 });
  return { userId: recipient.googleId, email: recipient.email, gift: true };
};

const purchaseDiscountOffer = async (session, {
  offerId,
  userId,
  userName,
  userEmail,
  recipientEmail,
  paymentMethod,
  paymentId,
  idempotencyKey,
  pin,
  expectedAmountPaise,
}) => {
  if (paymentMethod === 'Razorpay' && paymentId) {
    const existingOrder = await Order.findOne({ userId, razorpayId: paymentId, orderType: 'DISCOUNT_CODE' }).session(session).lean();
    if (existingOrder) {
      if (String(existingOrder.items?.[0]?.discountOfferId) !== String(offerId)) throw Object.assign(new Error('This payment was already used for a different discount offer.'), { status: 409 });
      const purchase = await PurchasedDiscountCode.findOne({ orderId: existingOrder.orderId }).session(session).lean();
      return { order: existingOrder, purchase, duplicate: true };
    }
  }
  if (paymentMethod === 'Wallet') {
    const referenceId = `discount-wallet:${idempotencyKey}`;
    const existingTransaction = await WalletTransaction.findOne({ userId, referenceId }).session(session).lean();
    if (existingTransaction) {
      const existingOrder = await Order.findOne({ userId, orderId: existingTransaction.orderId }).session(session).lean();
      const purchase = await PurchasedDiscountCode.findOne({ orderId: existingTransaction.orderId }).session(session).lean();
      if (existingOrder && purchase) {
        if (String(existingOrder.items?.[0]?.discountOfferId) !== String(offerId)) throw Object.assign(new Error('This purchase reference was already used for a different offer.'), { status: 409 });
        return { order: existingOrder, purchase, duplicate: true };
      }
      throw Object.assign(new Error('This discount-code purchase reference has already been used.'), { status: 409 });
    }
  }
  const now = new Date();
  const recipient = await resolveDiscountRecipient(session, userId, userEmail, recipientEmail);
  const offer = await DiscountCodeOffer.findOneAndUpdate(
    { _id: offerId, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } },
    { $inc: { availableQuantity: -1, purchasedCount: 1 } },
    { new: true, session },
  );
  if (!offer) throw Object.assign(new Error('This discount offer is no longer available.'), { status: 409 });
  const subscriptionDiscount = await subscriptionDiscountForAmount(userId, offer.sellingPricePaise, session);
  const payableAmountPaise = Math.max(0, offer.sellingPricePaise - subscriptionDiscount.amountPaise);
  if (expectedAmountPaise != null && expectedAmountPaise !== payableAmountPaise) {
    throw Object.assign(new Error('Your subscription benefit or discount offer price changed during payment.'), { status: 409 });
  }
  let wallet = null;
  let balanceBeforePaise = 0;
  if (paymentMethod === 'Wallet') {
    wallet = await Wallet.findOne({ userId }).session(session);
    if (!wallet?.pinHash) throw Object.assign(new Error('Set up your Wallet PIN before paying for this discount code.'), { status: 409 });
    if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
    await assertWalletSpendAvailable(userId, wallet, payableAmountPaise, session);
    if (wallet.balancePaise < payableAmountPaise) throw Object.assign(new Error('Insufficient Wallet balance.'), { status: 402 });
    balanceBeforePaise = wallet.balancePaise;
    wallet.balancePaise -= payableAmountPaise;
    await wallet.save({ session });
  }
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const purchaseId = `DCP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const [order] = await Order.create([{
    orderId,
    orderType: 'DISCOUNT_CODE',
    purchaseType: 'online',
    recipientType: recipient.gift ? 'gift' : 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `discount-offer-${offer._id}`, discountOfferId: String(offer._id), name: offer.name, category: 'Discount Code', price: money(offer.sellingPricePaise), quantity: 1 }],
    address: null,
    recipientUserId: recipient.gift ? recipient.userId : undefined,
    recipientEmail: recipient.gift ? recipient.email : undefined,
    deliveryRequired: false,
    discountCodePurchaseId: purchaseId,
    service: 'parts',
    projectDescription: '',
    subtotal: money(offer.sellingPricePaise),
    subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
    subscriptionDiscountPlan: subscriptionDiscount.plan,
    subscriptionDiscountPercent: subscriptionDiscount.percentage,
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: money(payableAmountPaise),
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise: wallet?.balancePaise,
    orderStatus: 'Confirmed',
    approvalStatus: 'not_required',
    statusHistory: [{ status: 'Confirmed', note: 'Discount Promo Code purchase confirmed and fulfilled.', createdAt: now }],
    razorpayId: paymentId || undefined,
  }], { session });
  const [purchase] = await PurchasedDiscountCode.create([{
    purchaseId,
    offerId: offer._id,
    code: offer.code,
    userId: recipient.userId,
    purchaserUserId: userId,
    recipientEmail: recipient.gift ? recipient.email : undefined,
    orderId,
    sellingPricePaise: offer.sellingPricePaise,
    discountType: offer.discountType,
    discountValuePaise: offer.discountValuePaise,
    discountPercent: offer.discountPercent,
    minimumPurchasePaise: offer.minimumPurchasePaise,
    eligibilityType: offer.eligibilityType || 'all',
    eligibleCategories: offer.eligibleCategories || [],
    eligibleProductIds: offer.eligibleProductIds || [],
    maxRedemptions: offer.maxRedemptions,
    maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer,
    purchasedAt: now,
    expiresAt: offer.expiresAt,
    fulfillmentStatus: 'fulfilled',
    transferable: false,
  }], { session });
  if (paymentMethod === 'Wallet') {
    await WalletTransaction.create([{
      userId,
      type: 'Purchase',
      amountPaise: -payableAmountPaise,
      balanceBeforePaise,
      balanceAfterPaise: wallet.balancePaise,
      referenceId: `discount-wallet:${idempotencyKey}`,
      orderId,
      description: `Discount Promo Code purchase ${orderId}`,
      status: 'Successful',
    }], { session });
  }
  await createInvoiceForOrder(session, order);
  await Notification.create([{
    userId: recipient.userId,
    type: 'discount_code_fulfilled',
    data: { purchaseId, orderId },
    message: `Your Discount Promo Code ${offer.code} is ready to use in your account.`,
  }], { session });
  return { order: order.toObject(), purchase: purchase.toObject(), wallet: wallet?.toObject(), duplicate: false };
};

const fulfillDiscountOfferItems = async (session, items, { userId, orderId }) => {
  const fulfilledCodes = [];
  for (const item of items.filter((orderItem) => orderItem.discountOfferId)) {
    const now = new Date();
    const offer = await DiscountCodeOffer.findOneAndUpdate(
      {
        _id: item.discountOfferId,
        active: true,
        startsAt: { $lte: now },
        expiresAt: { $gt: now },
        availableQuantity: { $gte: item.quantity },
      },
      { $inc: { availableQuantity: -item.quantity, purchasedCount: item.quantity } },
      { new: true, session },
    );
    if (!offer) throw Object.assign(new Error(`${item.name} is no longer available in the requested quantity.`), { status: 409 });
    const purchases = Array.from({ length: item.quantity }, () => ({
      purchaseId: `DCP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      offerId: offer._id,
      code: offer.code,
      userId,
      purchaserUserId: userId,
      orderId,
      sellingPricePaise: offer.sellingPricePaise,
      discountType: offer.discountType,
      discountValuePaise: offer.discountValuePaise,
      discountPercent: offer.discountPercent,
      minimumPurchasePaise: offer.minimumPurchasePaise,
      eligibilityType: offer.eligibilityType || 'all',
      eligibleCategories: offer.eligibleCategories || [],
      eligibleProductIds: offer.eligibleProductIds || [],
      maxRedemptions: offer.maxRedemptions,
      maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer,
      purchasedAt: now,
      expiresAt: offer.expiresAt,
      fulfillmentStatus: 'fulfilled',
      transferable: false,
      source: offer.source || 'ADMIN',
    }));
    const createdPurchases = await PurchasedDiscountCode.create(purchases, { session });
    fulfilledCodes.push(...createdPurchases.map((purchase) => ({
      code: purchase.code,
      purchaseId: purchase.purchaseId,
      offerName: offer.name,
      discountType: purchase.discountType,
      discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
      discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
    })));
  }
  return fulfilledCodes;
};

const discountCodesForOrder = async (orderId, session = null) => {
  let query = PurchasedDiscountCode.find({ orderId, fulfillmentStatus: 'fulfilled' }).sort({ purchasedAt: 1 });
  if (session) query = query.session(session);
  const purchases = await query.lean();
  return purchases.map((purchase) => ({
    code: purchase.code,
    purchaseId: purchase.purchaseId,
    discountType: purchase.discountType,
    discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
    discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
  }));
};

const activatePromoCode = (promo, activatedAt = new Date()) => {
  const validitySeconds = Number(promo.validitySeconds || 30 * 24 * 60 * 60);
  if (!Number.isSafeInteger(validitySeconds) || validitySeconds < 60) {
    throw Object.assign(new Error('The Promo Code validity is invalid.'), { status: 409 });
  }
  promo.activatedAt = activatedAt;
  promo.expiresAt = new Date(activatedAt.getTime() + validitySeconds * 1000);
  if (!Number.isFinite(promo.expiresAt.getTime())) throw Object.assign(new Error('The Promo Code expiry timestamp is invalid.'), { status: 409 });
};

const orderViewWithItemCancellations = (order) => {
  const value = order?.toObject ? order.toObject() : order;
  return {
    ...value,
    items: (value?.items || []).map((item, itemIndex) => {
      const savedCancellations = item.cancellations || [];
      const savedCancellationIds = new Set(savedCancellations.map((cancellation) => cancellation.cancellationId));
      const legacyCancellations = (value.cancellationEvents || []).flatMap((event) => (
        (event.items || [])
          .filter((cancelledItem) => Number(cancelledItem.itemIndex) === itemIndex
            && !savedCancellationIds.has(event.cancellationId))
          .map((cancelledItem) => ({
            cancellationId: event.cancellationId,
            quantity: cancelledItem.quantity,
            reason: event.reason,
            cancelledBy: event.userEmail || value.cancelledBy || 'Customer',
            source: 'CUSTOMER',
            cancelledAt: event.createdAt,
          }))
      ));
      const cancellations = [...savedCancellations, ...legacyCancellations];
      return cancellations.length ? { ...item, cancellations } : item;
    }),
  };
};

const buyerOrderView = (order) => {
  const value = orderViewWithItemCancellations(order);
  const items = value?.items || [];
  const hasItemCancellations = items.some((item) => Number(item.cancelledQuantity || 0) > 0);
  const allItemsCancelled = items.length > 0 && items.every((item) =>
    Number(item.cancelledQuantity || 0) >= Number(item.quantity || 0));
  let orderStatus = value?.orderStatus;
  if (allItemsCancelled) {
    orderStatus = 'Cancelled';
  } else if (hasItemCancellations && orderStatus === 'Cancelled') {
    orderStatus = items.find((item) =>
      Number(item.quantity || 0) > Number(item.cancelledQuantity || 0)
      && item.fulfillmentStatus
      && item.fulfillmentStatus !== 'Cancelled')?.fulfillmentStatus || 'Processing';
  }
  const shouldHidePromoCode = value?.recipientType === 'gift'
    || value?.orderType === 'PROMO_CODE' && value?.purchaseType === 'offline' && !value?.promoActivatedAt;
  const orderView = { ...value, orderCategory: value?.orderCategory || 'PART_ORDER', orderStatus, allItemsCancelled };
  return shouldHidePromoCode ? { ...orderView, promoCode: undefined } : orderView;
};

const adminOrdersView = async (orders) => {
  const ordersWithItemCancellations = orders.map((order) => ({
    ...buyerOrderView(order),
    promoCode: order.promoCode,
  }));
  const ordersMissingCode = ordersWithItemCancellations.filter((order) => order.orderType === 'PROMO_CODE' && !order.promoCode && order.promoCodeId && order.orderId);
  const [promoCodes, subscriptions] = await Promise.all([
    ordersMissingCode.length
      ? PromoCode.find({
        _id: { $in: ordersMissingCode.map((order) => order.promoCodeId) },
        orderId: { $in: ordersMissingCode.map((order) => order.orderId) },
      }).select('_id orderId code').lean()
      : [],
    ordersWithItemCancellations.length
      ? Subscription.find({
        userId: { $in: [...new Set(ordersWithItemCancellations.map((order) => order.userId).filter(Boolean))] },
        status: { $in: ['active', 'expired', 'renewal_failed'] },
      }).select('userId plan status expiryDate').sort({ expiryDate: -1 }).lean()
      : [],
  ]);
  const now = new Date();
  const subscriptionsByUser = new Map();
  for (const subscription of subscriptions) {
    const records = subscriptionsByUser.get(subscription.userId) || [];
    records.push(subscription);
    subscriptionsByUser.set(subscription.userId, records);
  }
  const currentSubscriptionsByUser = new Map([...subscriptionsByUser].map(([userId, records]) => {
    const active = records.find((subscription) =>
      subscription.status === 'active' && subscription.expiryDate && subscription.expiryDate > now);
    if (active) {
      return [userId, {
        plan: active.plan,
        status: 'Active',
        displayName: `Current Subscription: ${displayPlanName(active.plan)}`,
        expiryDate: active.expiryDate,
      }];
    }
    const expired = records.find((subscription) =>
      subscription.expiryDate && subscription.expiryDate <= now);
    return [userId, expired ? {
      plan: expired.plan,
      status: 'Expired',
      displayName: 'Subscription Expired',
      expiryDate: expired.expiryDate,
    } : {
      plan: null,
      status: 'none',
      displayName: 'No Active Subscription',
      expiryDate: null,
    }];
  }));
  const codesByOrder = new Map(promoCodes.map((promo) => [`${promo._id}:${promo.orderId}`, promo.code]));
  return ordersWithItemCancellations.map((order) => {
    const promoCode = codesByOrder.get(`${order.promoCodeId}:${order.orderId}`);
    return {
      ...order,
      currentSubscription: currentSubscriptionsByUser.get(order.userId) || {
        plan: null,
        status: 'none',
        displayName: 'No Active Subscription',
        expiryDate: null,
      },
      ...(order.orderType === 'PROMO_CODE' && !order.promoCode && promoCode ? { promoCode } : {}),
    };
  });
};

const completePromoCodeOrder = async (session, {
  promo,
  reservationId,
  userId,
  userName,
  userEmail,
  paymentMethod,
  idempotencyKey,
  razorpayPaymentId,
  walletBalanceAfterPaise,
}) => {
  const now = new Date();
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  activatePromoCode(promo, now);
  const recipientUserId = promo.recipientType === 'gift' ? promo.giftRecipientId : userId;
  if (!recipientUserId) throw Object.assign(new Error('The gift recipient must be verified before payment.'), { status: 409 });
  const recipient = promo.recipientType === 'gift'
    ? await User.findOne({ googleId: recipientUserId }).session(session).lean()
    : null;
  if (promo.recipientType === 'gift' && (!recipient || recipient.email !== promo.giftRecipientEmail)) {
    throw Object.assign(new Error('The verified gift recipient could not be confirmed.'), { status: 409 });
  }
  const recipientName = recipient?.name || userName;
  const purchasedPromo = await PromoCode.findOneAndUpdate(
    {
      _id: promo._id,
      status: 'reserved',
      reservationId,
      'reservationOwner.userId': userId,
      reservationExpiresAt: { $gt: now },
      paymentMethod,
    },
    {
      $set: {
        status: 'purchased',
        purchasedBy: { userId: recipientUserId, name: recipientName, email: recipient?.email || userEmail },
        giftBuyerId: userId,
        giftBuyerName: userName,
        giftBuyerEmail: userEmail,
        purchasedAt: now,
        activatedAt: promo.activatedAt,
        expiresAt: promo.expiresAt,
        purchaseIdempotencyKey: idempotencyKey,
        purchasePayableAmountPaise: promo.purchasePayableAmountPaise ?? promo.amountPaise,
        purchaseSubscriptionDiscountAmountPaise: promo.purchaseSubscriptionDiscountAmountPaise || 0,
        purchaseSubscriptionDiscountPlan: promo.purchaseSubscriptionDiscountPlan || 'Starter',
        purchaseSubscriptionDiscountPercent: promo.purchaseSubscriptionDiscountPercent || 0,
        orderId,
        razorpayPaymentId: razorpayPaymentId || undefined,
      },
    },
    { new: true, session },
  );
  if (!purchasedPromo) throw Object.assign(new Error('This Promo Code reservation expired or is no longer available.'), { status: 409 });

  const amount = money(purchasedPromo.amountPaise);
  const [order] = await Order.create([{
    orderId,
    orderType: 'PROMO_CODE',
    purchaseType: 'online',
    recipientType: promo.recipientType || 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `promo-${purchasedPromo._id}`, name: 'Promo Code', category: 'Promo Code', price: amount, quantity: 1 }],
    address: null,
    deliveryRequired: false,
    promoCodeId: purchasedPromo._id,
    promoReservationId: reservationId,
    promoCode: purchasedPromo.code,
    promoCodeAmountPaise: purchasedPromo.amountPaise,
    promoCodeStatus: 'PURCHASED',
    promoActivationStatus: 'active',
    promoActivatedAt: purchasedPromo.activatedAt,
    promoExpiresAt: purchasedPromo.expiresAt,
    promoMaxUses: purchasedPromo.maxUses || 10,
    promoSuccessfulUses: purchasedPromo.successfulUses || 0,
    recipientUserId,
    recipientEmail: recipient?.email || undefined,
    service: 'parts',
    projectDescription: '',
    subtotal: amount,
    subscriptionDiscountAmountPaise: Number(promo.purchaseSubscriptionDiscountAmountPaise || 0),
    subscriptionDiscountPlan: promo.purchaseSubscriptionDiscountPlan || 'Starter',
    subscriptionDiscountPercent: Number(promo.purchaseSubscriptionDiscountPercent || 0),
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: money(promo.purchasePayableAmountPaise ?? promo.amountPaise),
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise,
    orderStatus: 'Confirmed',
    approvalStatus: 'not_required',
    statusHistory: [{ status: 'Confirmed', note: 'Online Promo Code purchase confirmed.', createdAt: now }],
    razorpayId: razorpayPaymentId,
  }], { session });
  await awardRewardPointsForOrder(session, order);
  await createInvoiceForOrder(session, order);
  if (promo.recipientType === 'gift') {
    await Notification.create([{
      userId: recipientUserId,
      type: 'promo_gift_received',
      data: { orderId, buyerName: userName, buyerEmail: userEmail, promoName: 'Digital Wallet Credit', amount: money(purchasedPromo.amountPaise), receivedAt: now },
      message: `You received a Promo Code gift from ${userName}. It is ready in your Wallet.`,
    }, {
      userId,
      type: 'promo_gift_sent',
      data: { orderId, recipientEmail: recipient.email, amount: money(purchasedPromo.amountPaise) },
      message: `Your Promo Code gift order ${orderId} was confirmed and sent to ${recipient.email}.`,
    }], { session, ordered: true });
  } else {
    await Notification.create([{ userId, message: `Promo Code order ${orderId} was confirmed. The code is ready in your Wallet.` }], { session });
  }
  const cartItems = await removeOrderedItemsFromCart(session, userId, [{ id: `promo-${reservationId}`, quantity: 1 }]);
  return { promoCode: purchasedPromo.toObject(), order: order.toObject(), cartItems };
};

const createOfflinePromoCodeOrder = async (session, {
  promo,
  userId,
  userName,
  userEmail,
  address,
  buyerAddress,
  recipientAddress,
  recipientUserId,
  recipientEmail,
  recipientType: requestedRecipientType,
  paymentMethod,
  idempotencyKey,
  razorpayPaymentId,
  walletBalanceAfterPaise,
}) => {
  const now = new Date();
  const recipientType = requestedRecipientType || promo.recipientType || 'myself';
  if (recipientType === 'gift') promo.maxUses = 1;
  const orderId = `IL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  promo.status = 'pending_approval';
  promo.purchaseType = 'offline';
  promo.giftRecipientId = recipientType === 'gift' ? recipientUserId || undefined : undefined;
  promo.giftRecipientEmail = recipientType === 'gift' ? recipientEmail || undefined : undefined;
  promo.giftBuyerId = userId;
  promo.giftBuyerName = userName;
  promo.giftBuyerEmail = userEmail;
  promo.purchaseIdempotencyKey = idempotencyKey;
  promo.razorpayPaymentId = razorpayPaymentId || undefined;
  promo.purchasedAt = now;
  promo.orderId = orderId;
  await promo.save({ session });
  const [order] = await Order.create([{
    orderId,
    orderType: 'PROMO_CODE',
    purchaseType: 'offline',
    recipientType: recipientType || 'myself',
    userId,
    userName,
    userEmail,
    items: [{ id: `promo-${promo._id}`, name: 'Digital Wallet Credit', category: 'Promo Code', price: money(promo.amountPaise), quantity: 1 }],
    address: recipientAddress || address,
    buyerAddress,
    recipientAddress: recipientAddress || address,
    recipientUserId: recipientUserId || undefined,
    recipientEmail: recipientEmail || undefined,
    deliveryRequired: true,
    promoCodeId: promo._id,
    promoReservationId: promo.reservationId,
    promoCode: promo.code,
    promoCodeAmountPaise: promo.amountPaise,
    service: 'parts',
    projectDescription: '',
    subtotal: money(promo.amountPaise),
    subscriptionDiscountAmountPaise: Number(promo.purchaseSubscriptionDiscountAmountPaise || 0),
    subscriptionDiscountPlan: promo.purchaseSubscriptionDiscountPlan || 'Starter',
    subscriptionDiscountPercent: Number(promo.purchaseSubscriptionDiscountPercent || 0),
    codingCharge: 0,
    buildingCharge: 0,
    deliveryCharge: 0,
    total: money(promo.purchasePayableAmountPaise ?? promo.amountPaise),
    paymentStatus: 'Paid',
    paymentMethod,
    walletBalanceAfterPaise,
    orderStatus: 'Pending Admin Approval',
    approvalStatus: 'pending',
    promoActivationStatus: 'pending',
    promoMaxUses: promo.maxUses || 10,
    promoSuccessfulUses: promo.successfulUses || 0,
    statusHistory: [{ status: 'Pending Admin Approval', note: 'Offline Promo Code order paid and awaiting admin approval.', createdAt: now }],
    razorpayId: razorpayPaymentId,
  }], { session });
  await createInvoiceForOrder(session, order);
  await Notification.create([{
    userId,
    message: `Offline Promo Code order ${orderId} was paid and is awaiting admin approval. The code will be activated after approval.`,
  }], { session });
  const cartItems = await removeOrderedItemsFromCart(session, userId, [{ id: `promo-${promo.reservationId}`, quantity: 1 }]);
  return { order: order.toObject(), promoCode: null, cartItems };
};

const validateCreditQuantity = (value) => {
  const credits = Number(value);
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > aiCreditMaxPurchase) {
    throw Object.assign(new Error(`Enter a whole number of credits between 1 and ${aiCreditMaxPurchase.toLocaleString('en-IN')}.`), { status: 400 });
  }
  return credits;
};

const creditPurchaseView = (purchase) => ({
  purchaseId: purchase.purchaseId,
  credits: purchase.credits,
  pricePerCredit: money(purchase.pricePerCreditPaise),
  baseAmount: money(purchase.baseAmountPaise || purchase.totalAmountPaise),
  subscriptionDiscountAmount: money(purchase.subscriptionDiscountAmountPaise || 0),
  subscriptionDiscountPlan: purchase.subscriptionDiscountPlan || 'Starter',
  subscriptionDiscountPercent: purchase.subscriptionDiscountPercent || 0,
  totalAmount: money(purchase.totalAmountPaise),
  currency: purchase.currency,
  paymentMethod: purchase.paymentMethod,
  status: purchase.status,
  razorpayOrderId: purchase.razorpayOrderId || null,
  previousBalance: purchase.previousBalance,
  newBalance: purchase.newBalance,
  completedAt: purchase.completedAt || null,
});

const addPurchasedCredits = async (session, purchase, paymentReference) => {
  await AICredits.updateOne(
    { userId: purchase.userId },
    { $setOnInsert: {
      userId: purchase.userId,
      balance: 0,
      includedCredits: 0,
      purchasedCredits: 0,
      usedCredits: 0,
      includedCreditsRemaining: 0,
      purchasedCreditsRemaining: 0,
      creditBucketsInitialized: true,
    } },
    { upsert: true, session },
  );
  const current = await ensureAiCreditBuckets(purchase.userId, session);
  if (!current) throw new Error('AI credit balance could not be initialized.');
  const previousBalance = current?.balance || 0;
  const credits = await AICredits.findOneAndUpdate(
    { userId: purchase.userId },
    { $inc: { balance: purchase.credits, purchasedCredits: purchase.credits, purchasedCreditsRemaining: purchase.credits } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session },
  );
  await AICreditTransaction.create([{
    userId: purchase.userId,
    type: 'added',
    amount: purchase.credits,
    action: 'credit_purchase',
    reference: paymentReference,
    purchaseId: purchase.purchaseId,
    paymentMethod: purchase.paymentMethod,
    amountPaise: purchase.totalAmountPaise,
    previousBalance,
    balanceAfter: credits.balance,
  }], { session });
  purchase.status = 'completed';
  purchase.previousBalance = previousBalance;
  purchase.newBalance = credits.balance;
  purchase.completedAt = new Date();
  await purchase.save({ session });
  await createInvoiceForStandalonePurchase(session, {
    userId: purchase.userId,
    orderId: `AI-${purchase.purchaseId}`,
    paymentId: paymentReference,
    paymentMethod: purchase.paymentMethod,
    itemName: `${purchase.credits.toLocaleString('en-IN')} AI Credits`,
    amountPaise: purchase.totalAmountPaise,
    baseAmountPaise: purchase.baseAmountPaise || purchase.totalAmountPaise,
    subscriptionDiscountAmountPaise: purchase.subscriptionDiscountAmountPaise || 0,
    subscriptionDiscountPlan: purchase.subscriptionDiscountPlan || 'Starter',
    subscriptionDiscountPercent: purchase.subscriptionDiscountPercent || 0,
  });
  return { credits, purchase };
};

const finalizeRazorpayCreditPurchase = async ({ userId, purchaseId, orderId, payment }) => withMongoTransaction(async (session) => {
  const purchase = await CreditPurchase.findOne({ purchaseId, userId }).session(session);
  if (!purchase) throw Object.assign(new Error('Credit purchase was not found.'), { status: 404 });
  if (purchase.status === 'completed') {
    if (purchase.razorpayPaymentId !== payment.id) throw Object.assign(new Error('This credit purchase was completed with another payment.'), { status: 409 });
    const credits = await AICredits.findOne({ userId }).session(session).lean();
    return { purchase, balance: credits?.balance || purchase.newBalance || 0, duplicate: true };
  }
  if (!['pending', 'processing'].includes(purchase.status) || purchase.razorpayOrderId !== orderId
    || payment.order_id !== orderId || payment.amount !== purchase.totalAmountPaise
    || payment.currency !== 'INR' || payment.status !== 'captured') {
    throw Object.assign(new Error('Payment amount or status could not be verified.'), { status: 409 });
  }
  purchase.razorpayPaymentId = payment.id;
  const completed = await addPurchasedCredits(session, purchase, `credit:${purchase.purchaseId}`);
  await Notification.create([{ userId, message: `${completed.purchase.credits.toLocaleString('en-IN')} AI credits were added to your account.` }], { session });
  return { purchase: completed.purchase, balance: completed.credits.balance, duplicate: false };
});

const resolveOrderItems = async (items, userId) => {
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    throw Object.assign(new Error('The order must contain at least one item.'), { status: 400 });
  }
  const customIds = items.filter((item) => item?.customOrderId).map((item) => item.customOrderId);
  if (customIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw Object.assign(new Error('A custom item is invalid.'), { status: 400 });
  }
  const customOrders = customIds.length
    ? await CustomOrder.find({ _id: { $in: customIds }, userId, status: 'Accepted' }).lean()
    : [];
  const customOrderById = new Map(customOrders.map((order) => [String(order._id), order]));
  const safeItems = [];
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw Object.assign(new Error('Item quantity is invalid.'), { status: 400 });
    }
    if ((item?.promoReservationId || item?.promoCodeId || String(item?.id || '').startsWith('promo-')) && quantity !== 1) {
      throw Object.assign(new Error('Promo Codes can only be purchased one at a time.'), { status: 400 });
    }
    if (item?.discountOfferId) {
      if (!mongoose.isValidObjectId(item.discountOfferId)) throw Object.assign(new Error('A Discount Promo Code offer is invalid.'), { status: 400 });
      const now = new Date();
      const offer = await DiscountCodeOffer.findOne({
        _id: item.discountOfferId,
        active: true,
        startsAt: { $lte: now },
        expiresAt: { $gt: now },
        availableQuantity: { $gte: quantity },
      }).select('_id name sellingPricePaise availableQuantity').lean();
      if (!offer) throw Object.assign(new Error('This Discount Promo Code is no longer available in the requested quantity.'), { status: 409 });
      safeItems.push({
        id: `discount-offer-${offer._id}`,
        discountOfferId: String(offer._id),
        name: offer.name,
        category: 'Discount Promo Code',
        price: money(offer.sellingPricePaise),
        quantity,
      });
      continue;
    }
    if (item.customOrderId) {
      const customOrder = customOrderById.get(String(item.customOrderId));
      if (!customOrder) throw Object.assign(new Error('An accepted custom item is no longer available.'), { status: 409 });
      safeItems.push({ id: `custom-${customOrder._id}`, customOrderId: String(customOrder._id), name: customOrder.requestedItem, category: 'Custom Order', price: customOrder.price, quantity });
    } else {
      const productId = String(item?.id || '');
      const inventoryItem = await InventoryItem.findOne({ productId }).lean();
      if (!inventoryItem) throw Object.assign(new Error('An item in the cart is unavailable.'), { status: 400 });
      if (inventoryItem.status === 'Out of Stock') throw Object.assign(new Error(`${inventoryItem.name} is currently out of stock.`), { status: 409 });
      if (inventoryItem.stock < quantity) throw Object.assign(new Error(`Insufficient stock for ${inventoryItem.name}.`), { status: 409 });
      safeItems.push({
        id: productId,
        name: inventoryItem.name,
        category: inventoryItem.category || 'Other Components',
        price: inventoryItem.pricePaise / 100,
        quantity,
        cancellable: inventoryItem.cancellable !== false,
      });
    }
  }
  return { safeItems, customOrders };
};

const catalogPrices = new Map([
  ['arduino-uno', ['Arduino Uno', 'Arduino Uno', 980]],
  ['ultrasonic-sensor-hc-sr04', ['Ultrasonic Sensor HC-SR04', 'Sensors', 220]],
  ['ir-obstacle-sensor', ['IR Obstacle Sensor', 'Sensors', 90]],
  ['ldr-light-sensor', ['LDR Light Sensor', 'Sensors', 45]],
  ['pir-motion-sensor', ['PIR Motion Sensor', 'Sensors', 180]],
  ['dht11-temperature-humidity-sensor', ['DHT11 Temperature & Humidity Sensor', 'Sensors', 140]],
  ['soil-moisture-sensor', ['Soil Moisture Sensor', 'Sensors', 110]],
  ['rain-sensor', ['Rain Sensor', 'Sensors', 120]],
  ['flame-sensor', ['Flame Sensor', 'Sensors', 95]],
  ['sound-noise-sensor', ['Sound/Noise Sensor', 'Sensors', 85]],
  ['water-level-sensor', ['Water Level Sensor', 'Sensors', 100]],
  ['gas-sensor', ['Gas Sensor', 'Sensors', 160]],
  ['touch-sensor', ['Touch Sensor', 'Sensors', 55]],
  ['pulse-heart-sensor', ['Pulse/Heart Sensor', 'Sensors', 240]],
  ['ir-receiver-sensor', ['IR Receiver Sensor', 'Sensors', 65]],
  ['joystick-module', ['Joystick Module', 'Modules', 130]],
  ['relay-module', ['Relay Module', 'Modules', 95]],
  ['12v-dc-gear-motor', ['12V DC Gear Motor', 'Motors', 680]],
  ['sg90-servo-motor', ['SG90 Servo Motor', 'Motors', 160]],
  ['high-torque-servo-motor', ['High Torque Servo Motor', 'Motors', 620]],
  ['l298n-motor-driver', ['L298N Motor Driver', 'Motor Drivers', 420]],
  ['i2c-lcd-display', ['I2C LCD Display', 'Displays', 260]],
  ['7-segment-display', ['7-Segment Display', 'Displays', 75]],
  ['oled-display', ['OLED Display', 'Displays', 550]],
  ['passive-buzzer', ['Passive Buzzer', 'Buzzers & LEDs', 35]],
  ['leds', ['LEDs', 'Buzzers & LEDs', 20]],
  ['push-buttons', ['Push Buttons', 'Components', 15]],
  ['potentiometer', ['Potentiometer', 'Components', 35]],
  ['breadboard', ['Breadboard', 'Power & Wiring', 120]],
  ['jumper-wires', ['Jumper Wires', 'Power & Wiring', 90]],
  ['battery-holder', ['Battery Holder', 'Power & Wiring', 45]],
  ['9v-battery', ['9V Battery', 'Power & Wiring', 55]],
  ['dc-power-supply-module', ['DC Power Supply Module', 'Power & Wiring', 180]],
]);

const seedInventory = async () => {
  if (mongoose.connection.readyState !== 1) return;
  const catalogEntries = [...catalogPrices.entries()];
  const categoryCorrections = catalogEntries
    .filter(([, [, category]]) => category !== 'Other Components')
    .map(([productId, [, category]]) => ({
      updateOne: {
        filter: { productId, category: { $in: ['Other Components', null, ''] } },
        update: { $set: { category } },
      },
    }));
  if (categoryCorrections.length) await InventoryItem.bulkWrite(categoryCorrections);
  const operations = catalogEntries.map(([productId, [name, category, price]]) => ({
    updateOne: {
      filter: { productId },
      update: {
        $setOnInsert: {
          productId,
          name,
          category,
          pricePaise: toPaise(price),
          description: `${name} for Arduino prototypes, robotics, and hands-on electronics projects.`,
          stock: 10,
          status: 'In Stock',
        },
      },
      upsert: true,
    },
  }));
  if (operations.length) await InventoryItem.bulkWrite(operations);
};

const validateAddress = (address) => address &&
  ['fullName', 'phoneNumber', 'addressLine1', 'city', 'state', 'pinCode', 'country']
    .every((field) => typeof address[field] === 'string' && address[field].trim());

const orderRequiresDelivery = (items) => (items || []).some((item) => !item.discountOfferId);

const resolvePromoRecipient = async (session, { promo, userId, userEmail, recipientEmail = '' }) => {
  if (promo.recipientType !== 'gift') return { recipientUserId: null, recipientEmail: '' };
  if (promo.purchaseType === 'online') {
    if (!promo.giftRecipientId || !promo.giftRecipientEmail) {
      throw Object.assign(new Error('Verify the recipient email before continuing to payment.'), { status: 409 });
    }
    return { recipientUserId: promo.giftRecipientId, recipientEmail: promo.giftRecipientEmail };
  }
  const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw Object.assign(new Error('Enter the registered email address of the gift recipient.'), { status: 400 });
  }
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error('Enter a valid recipient email address.'), { status: 400 });
  }
  const recipient = await User.findOne({ email: normalizedEmail }).select('googleId email').session(session).lean();
  if (!recipient) {
    throw Object.assign(new Error('The recipient email must belong to a registered Innovation Labs account.'), { status: 404 });
  }
  if (recipient.googleId === userId) {
    throw Object.assign(new Error('Choose a different registered Innovation Labs account for an offline gift.'), { status: 400 });
  }
  return { recipientUserId: recipient.googleId, recipientEmail: recipient.email };
};

const aiPlanEntitlements = {
  Starter: { buildLimit: null, addComponents: false, checkoutAssistance: false },
  Medium: { buildLimit: null, addComponents: false, checkoutAssistance: false },
  Premium: { buildLimit: null, addComponents: true, checkoutAssistance: false },
  Exclusive: { buildLimit: null, addComponents: true, checkoutAssistance: true },
};

const getAiMonthlyAllowanceForPlan = (planName) => Number(aiBillAllowanceByPlan[String(planName || 'Starter')] || 0);
const ensureAiCreditBuckets = async (userId, session) => {
  let credits = await AICredits.findOne({ userId }).session(session || null);
  if (!credits || credits.creditBucketsInitialized) return credits;
  const balance = Math.max(0, Number(credits.balance || 0));
  const purchasedCreditsRemaining = Math.min(balance, Math.max(0, Number(credits.purchasedCredits || 0)));
  await AICredits.updateOne(
    { _id: credits._id, creditBucketsInitialized: { $ne: true } },
    { $set: {
      includedCreditsRemaining: balance - purchasedCreditsRemaining,
      purchasedCreditsRemaining,
      creditBucketsInitialized: true,
    } },
    { session: session || undefined },
  );
  credits = await AICredits.findOne({ userId }).session(session || null);
  if (!credits) throw new Error('AI credit balance could not be loaded.');
  return credits;
};
const expireIncludedSubscriptionCredits = async (userId, session, subscription) => {
  const credits = await ensureAiCreditBuckets(userId, session);
  const amount = Number(credits?.includedCreditsRemaining || 0);
  if (!credits || amount <= 0) return 0;
  if (!Number.isSafeInteger(amount) || credits.balance < amount) {
    throw new Error('The included AI credit balance is inconsistent and could not be expired safely.');
  }
  const previousBalance = credits.balance;
  credits.balance -= amount;
  credits.includedCreditsRemaining = 0;
  await credits.save({ session });
  await AICreditTransaction.create([{
    userId,
    type: 'expired',
    amount,
    action: 'Unused subscription credits expired',
    reference: `subscription-credit-expiry:${subscription._id}`,
    previousBalance,
    balanceAfter: credits.balance,
  }], { session });
  return amount;
};
const aiBillPeriod = (subscription, now = new Date()) => {
  if (!subscription) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { key: `calendar:${start.toISOString().slice(0, 7)}`, next };
  }
  const anchor = new Date(subscription.billAllowancePeriodStart || subscription.startDate);
  const monthIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
  const currentMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const dateForMonth = (index) => {
    const year = Math.floor(index / 12);
    const month = index % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ));
  };
  let startIndex = currentMonthIndex;
  if (dateForMonth(startIndex) > now) startIndex -= 1;
  const start = dateForMonth(Math.max(monthIndex, startIndex));
  const nextMonth = dateForMonth(Math.max(monthIndex, startIndex) + 1);
  const expiry = new Date(subscription.expiryDate);
  const next = Number.isFinite(expiry.getTime()) && expiry < nextMonth ? expiry : nextMonth;
  return { key: `subscription:${subscription._id}:${start.toISOString()}`, next };
};
const getAiBillAllowanceForSubscription = (subscription) => {
  if (subscription?.plan === 'Exclusive' && !subscription.autoRenew) return 0;
  return getAiMonthlyAllowanceForPlan(subscription?.plan || 'Starter');
};
const ensureAiBillAllowance = async (userId, session, subscription) => {
  const period = aiBillPeriod(subscription);
  const allowance = getAiBillAllowanceForSubscription(subscription);
  await AICredits.updateOne(
    { userId },
    { $setOnInsert: { userId, balance: 0, includedCredits: 0, purchasedCredits: 0, usedCredits: 0, includedCreditsRemaining: 0, purchasedCreditsRemaining: 0, creditBucketsInitialized: true, purchasedBills: 0 } },
    { upsert: true, session },
  );
  let creditState = await AICredits.findOne({ userId }).session(session);
  if (!creditState) throw new Error('AI bill balance could not be initialized.');
  if (creditState.lastBillAllowancePeriod !== period.key) {
    const previousPeriod = creditState.lastBillAllowancePeriod || '';
    const previousPeriodFilter = previousPeriod
      ? { lastBillAllowancePeriod: previousPeriod }
      : { $or: [{ lastBillAllowancePeriod: '' }, { lastBillAllowancePeriod: { $exists: false } }] };
    const update = await AICredits.updateOne(
      { userId, ...previousPeriodFilter },
      { $set: { includedBills: allowance, usedBills: 0, lastBillAllowancePeriod: period.key } },
      { session },
    );
    if (update.modifiedCount === 1) {
      await AIBillTransaction.create([{
        userId,
        type: 'allowance',
        quantity: allowance,
        reference: `bill-allowance:${userId}:${period.key}`,
        periodKey: period.key,
        source: subscription?.plan || 'Starter',
        includedRemaining: allowance,
        purchasedRemaining: Number(creditState.purchasedBills || 0),
      }], { session });
    }
    creditState = await AICredits.findOne({ userId }).session(session);
  }
  return creditState;
};
const getAiBillSummary = async (userId, session = null) => {
  if (!session) {
    await currentSubscription(userId);
    return withMongoTransaction((transaction) => getAiBillSummary(userId, transaction));
  }
  const subscription = await currentSubscription(userId, session);
  const plan = subscription?.plan || 'Starter';
  const billState = await ensureAiBillAllowance(userId, session, subscription);
  const includedRemaining = Math.max(0, Number(billState.includedBills || 0) - Number(billState.usedBills || 0));
  const purchasedRemaining = Math.max(0, Number(billState.purchasedBills || 0));
  return {
    plan,
    includedAllowance: Number(billState.includedBills || 0),
    includedRemaining,
    purchasedBills: Number(billState.purchasedBills || 0),
    purchasedRemaining,
    usedBills: Number(billState.usedBills || 0),
    totalAvailable: includedRemaining + purchasedRemaining,
    nextAllowanceReset: aiBillPeriod(subscription).next,
    periodKey: billState.lastBillAllowancePeriod,
  };
};
const consumeAiBill = async (session, userId, buildId) => {
  const subscription = await currentSubscription(userId, session);
  const state = await ensureAiBillAllowance(userId, session, subscription);
  let updated = null;
  let type = 'included';
  if (Number(state.usedBills || 0) < Number(state.includedBills || 0)) {
    updated = await AICredits.findOneAndUpdate(
      { userId, usedBills: state.usedBills, lastBillAllowancePeriod: state.lastBillAllowancePeriod, $expr: { $lt: ['$usedBills', '$includedBills'] } },
      { $inc: { usedBills: 1 } },
      { new: true, session },
    );
  }
  if (!updated) {
    type = 'purchased';
    updated = await AICredits.findOneAndUpdate(
      { userId, purchasedBills: { $gt: 0 }, lastBillAllowancePeriod: state.lastBillAllowancePeriod },
      { $inc: { purchasedBills: -1 } },
      { new: true, session },
    );
  }
  if (!updated) throw Object.assign(new Error('You have no AI bills remaining. Add AI bills to continue building.'), { status: 403, code: 'AI_BILL_LIMIT' });
  await AIBillTransaction.create([{
    userId,
    type: 'used',
    quantity: 1,
    reference: `ai-build-bill:${buildId}`,
    periodKey: updated.lastBillAllowancePeriod,
    source: type,
    includedRemaining: Math.max(0, updated.includedBills - updated.usedBills),
    purchasedRemaining: updated.purchasedBills,
    buildId: String(buildId),
  }], { session });
  return updated;
};

const planFeatures = [
  ['Normal website, product browsing, cart and checkout', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Razorpay and wallet payments', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Discount on every order', ['Starter', 'Medium', 'Premium', 'Exclusive'], { Starter: '0% OFF', Medium: '3% OFF', Premium: '2% OFF', Exclusive: '4% OFF' }],
  ['QR Code Wallet Transfers', ['Exclusive'], { Starter: 'No', Medium: 'No', Premium: 'No', Exclusive: 'Yes' }],
  ['Promo-code wallet system and order tracking', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['Priority customer support', ['Medium', 'Premium', 'Exclusive']],
  ['Priority delivery where supported', ['Medium', 'Premium', 'Exclusive']],
  ['Additional account features', ['Medium', 'Premium', 'Exclusive']],
  ['AI Project Builder', ['Starter', 'Medium', 'Premium', 'Exclusive'], { Starter: 'Bill-based', Medium: 'Bill-based', Premium: 'Bill-based', Exclusive: 'Bill-based' }],
  ['AI bills included monthly', ['Starter', 'Medium', 'Premium', 'Exclusive'], Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, `${config.includedAiBills} bills`]))],
  ['Purchase additional AI bills', ['Starter', 'Medium', 'Premium', 'Exclusive'], { Starter: '₹200 each', Medium: '₹200 each', Premium: '₹200 each', Exclusive: '₹200 each' }],
  ['AI-assisted cart addition', ['Premium', 'Exclusive'], { Starter: 'No', Medium: 'No', Premium: 'Yes', Exclusive: 'Yes' }],
  ['AI-assisted checkout assistance', ['Exclusive'], { Starter: 'No', Medium: 'No', Premium: 'No', Exclusive: 'Yes · confirmation required' }],
  ['Trial cashback', [], { Starter: 'No', Medium: 'No', Premium: 'No', Exclusive: 'No' }],
  ['AI shopping assistant and product search', []],
  ['AI product identification and specifications', []],
  ['AI screen commands and website navigation', []],
  ['AI credits', ['Starter', 'Medium', 'Premium', 'Exclusive']],
  ['AI credits included each month', ['Premium', 'Exclusive'], Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, `${config.credits.toLocaleString('en-IN')} credits`]))],
  ['Maximum wallet balance', ['Starter', 'Medium', 'Premium', 'Exclusive'], Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, `₹${money(config.walletLimitPaise).toLocaleString('en-IN')}`]))],
  ['One-time wallet cashback on activation', ['Premium', 'Exclusive']],
  ['AI purchase with explicit final confirmation', []],
  ['Additional advanced AI and account assistance', []],
];

const getPlanSummary = () => Object.entries(planConfig).map(([name, config]) => ({
  name,
  displayName: displayPlanName(name),
  price: money(config.pricePaise),
  credits: config.credits,
  cashback: money(config.cashbackPaise),
  walletLimit: money(config.walletLimitPaise || 0),
  includedAiBills: config.includedAiBills || 0,
  subscriptionDiscountPercent: SUBSCRIPTION_DISCOUNT_PERCENT[name] || 0,
  features: planFeatures.map(([label, included, values]) => ({ label, included: included.includes(name), value: values?.[name] || null })),
}));

const addMonths = (date, months) => {
  const source = new Date(date);
  if (Number.isNaN(source.getTime()) || !Number.isSafeInteger(months) || months < 1 || months > maxSubscriptionDurationMonths) {
    throw new Error('Subscription duration or start timestamp is invalid.');
  }
  const targetMonth = source.getUTCMonth() + months;
  const target = new Date(Date.UTC(source.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  target.setUTCHours(source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds());
  return target;
};
const addOneMonth = (date) => addMonths(date, 1);
const subscriptionDurationMonths = (value) => {
  const months = Number(value ?? 1);
  if (!Number.isSafeInteger(months) || months < 1 || months > maxSubscriptionDurationMonths) {
    throw Object.assign(new Error(`Choose a subscription duration between 1 and ${maxSubscriptionDurationMonths} months.`), { status: 400 });
  }
  return months;
};

const renewDueSubscriptions = async (userId) => {
  if (mongoose.connection.readyState !== 1) return;
  const dueSubscriptions = await Subscription.find({ userId, status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } }).lean();
  for (const due of dueSubscriptions) {
    await withMongoTransaction(async (session) => {
      const subscription = await Subscription.findOne({ _id: due._id, status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } }).session(session);
      if (!subscription) return;
      const config = planConfig[subscription.plan];
      const paymentReference = `renewal:${subscription._id}:${subscription.expiryDate.getTime()}`;
      const wallet = await Wallet.findOne({ userId }).session(session);
      const availableBalancePaise = wallet
        ? Math.min(
          Math.max(0, wallet.balancePaise - Number(wallet.restrictedBalancePaise || 0)),
          getPlanWalletLimit(subscription.plan),
        )
        : 0;
      if (!wallet || wallet.balancePaise < config.pricePaise || availableBalancePaise < config.pricePaise) {
        const graceStartedAt = subscription.expiryDate;
        const graceEndsAt = new Date(graceStartedAt.getTime() + 48 * 60 * 60 * 1000);
        subscription.status = 'renewal_failed';
        subscription.expiredAt = graceStartedAt;
        subscription.graceStartedAt = graceStartedAt;
        subscription.graceEndsAt = graceEndsAt;
        subscription.previousPlan = subscription.plan;
        subscription.effectivePlan = 'Starter';
        subscription.renewalHistory.push({ date: new Date(), status: 'Failed', paymentReference, amountPaise: config.pricePaise });
        await subscription.save({ session });
        await expireIncludedSubscriptionCredits(userId, session, subscription);
        await ensureAiBillAllowance(userId, session, null);
        await syncWalletRestrictionState(userId, session);
        await Notification.create([{
          userId,
          message: `${displayPlanName(subscription.plan)} subscription expired at ${graceStartedAt.toISOString()} and could not renew because your available wallet balance was insufficient. Your account is now on Starter with a 48-hour wallet grace period.`,
        }], { session });
        return;
      }

      const now = new Date();
      const renewalStartDate = new Date(subscription.expiryDate);
      const renewalExpiryDate = addOneMonth(now);
      const before = wallet.balancePaise;
      wallet.balancePaise -= config.pricePaise;
      await wallet.save({ session });
      await WalletTransaction.create([{
        userId,
        type: 'Purchase',
        amountPaise: -config.pricePaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: paymentReference,
        description: `${displayPlanName(subscription.plan)} automatic renewal`,
        status: 'Successful',
      }], { session });
      subscription.billAllowancePeriodStart = subscription.expiryDate;
      subscription.expiryDate = renewalExpiryDate;
      subscription.paymentMethod = 'Wallet';
      subscription.paymentReference = paymentReference;
      subscription.expiredAt = null;
      subscription.graceStartedAt = null;
      subscription.graceEndsAt = null;
      subscription.previousPlan = null;
      subscription.effectivePlan = subscription.plan;
      subscription.renewalHistory.push({ date: now, status: 'Successful', paymentReference, amountPaise: config.pricePaise });
      await subscription.save({ session });
      await SubscriptionTransaction.create([{
        userId,
        orderCategory: 'SUBSCRIPTION_ORDER',
        transactionType: 'renewal',
        plan: subscription.plan,
        amountPaise: config.pricePaise,
        creditsAllocated: config.credits,
        billsAllocated: config.includedAiBills,
        durationMonths: 1,
        monthlyPricePaise: config.pricePaise,
        subscriptionId: subscription._id,
        orderId: `SUB-${paymentReference}`,
        startDate: renewalStartDate,
        expiryDate: renewalExpiryDate,
        paymentMethod: 'Wallet',
        paymentReference,
        cashbackPaise: 0,
        status: 'Successful',
      }], { session });
      if (config.credits > 0) {
        await ensureAiCreditBuckets(userId, session);
        const credits = await AICredits.findOneAndUpdate(
          { userId },
          {
            $inc: { balance: config.credits, includedCredits: config.credits, includedCreditsRemaining: config.credits },
            $setOnInsert: { purchasedCreditsRemaining: 0, creditBucketsInitialized: true },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true, session },
        );
        await AICreditTransaction.create([{
          userId,
          type: 'added',
          amount: config.credits,
          action: `${displayPlanName(subscription.plan)} monthly renewal credits`,
          reference: `subscription-credits:${paymentReference}`,
          balanceAfter: credits.balance,
        }], { session });
      }
      await ensureAiBillAllowance(userId, session, subscription.toObject());
    });
  }
};

const currentSubscription = async (userId, session) => {
  const now = new Date();
  if (!session) await renewDueSubscriptions(userId);
  const expiredCandidate = await Subscription.find({ userId, status: 'active', expiryDate: { $lte: now } }).session(session || null).lean();
  for (const expired of expiredCandidate) {
    const transition = async (lifecycleSession) => {
      const graceStartedAt = expired.expiryDate;
      const graceEndsAt = new Date(graceStartedAt.getTime() + 48 * 60 * 60 * 1000);
      const updated = await Subscription.updateOne(
        { _id: expired._id, status: 'active', expiryDate: { $lte: now } },
        { $set: {
          status: 'expired',
          expiredAt: graceStartedAt,
          previousPlan: expired.plan,
          effectivePlan: 'Starter',
          graceStartedAt,
          graceEndsAt,
        } },
        { session: lifecycleSession },
      );
      if (updated.modifiedCount) {
        await expireIncludedSubscriptionCredits(userId, lifecycleSession, expired);
        await ensureAiBillAllowance(userId, lifecycleSession, null);
        await syncWalletRestrictionState(userId, lifecycleSession);
      }
    };
    if (session) await transition(session);
    else await withMongoTransaction(transition);
  }
  return Subscription.findOne({ userId, status: 'active', expiryDate: { $gt: now } }).sort({ expiryDate: -1 }).session(session || null).lean();
};

const subscriptionDiscountForAmount = async (userId, amountPaise, session) => {
  const subscription = await currentSubscription(userId, session);
  return calculateSubscriptionDiscount(subscription?.plan || 'Starter', amountPaise);
};

const requireActiveExclusiveCreditAccess = async (req, res, next) => {
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan !== 'Exclusive') {
    return res.status(403).json({ message: 'Add Credits is available to active Exclusive subscribers only.' });
  }
  return next();
};

const requireActiveExclusiveQrTransfer = async (req, res, next) => {
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan !== 'Exclusive') {
    return res.status(403).json({
      code: 'EXCLUSIVE_QR_TRANSFER_REQUIRED',
      message: 'Scan-to-transfer is available to active Exclusive subscribers only.',
    });
  }
  return next();
};

const requireExclusiveQrTransferWhenUsed = async (req, res, next) => {
  if (typeof req.body?.qrPayload !== 'string' || !req.body.qrPayload.trim()) return next();
  return requireActiveExclusiveQrTransfer(req, res, next);
};

const requireExclusiveCreditAccess = async (req, res, next) => {
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan === 'Exclusive') return next();
  const purchaseId = req.params.purchaseId || req.body?.purchaseId;
  const pendingPurchase = purchaseId && await CreditPurchase.exists({
    purchaseId,
    userId: req.session.sub,
    authorizedPlan: 'Exclusive',
    status: { $in: ['pending', 'processing', 'completed'] },
  });
  if (pendingPurchase) return next();
  return res.status(403).json({ message: 'Add Credits is available to active Exclusive subscribers only.' });
};

const aiTrialView = (trial, now = new Date()) => ({
  used: Boolean(trial),
  active: Boolean(trial && trial.status === 'active' && trial.expiresAt > now),
  plan: trial?.plan || null,
  activatedAt: trial?.activatedAt || null,
  expiresAt: trial?.expiresAt || null,
  expirationWarningShownAt: trial?.expirationWarningShownAt || null,
  remainingBuilds: trial ? Math.max(0, trial.buildLimit - trial.successfulBuilds) : null,
  buildLimit: trial?.buildLimit ?? 2,
});

const getAiAccess = async (userId) => {
  const now = new Date();
  const [subscription, trial] = await Promise.all([
    currentSubscription(userId),
    AITrial.findOne({ userId }).lean(),
  ]);
  const activeTrial = trial?.status === 'active' && trial.expiresAt > now ? trial : null;
  if (trial?.status === 'active' && trial.expiresAt <= now) {
    await AITrial.updateOne({ _id: trial._id, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
  }
  const plan = subscription?.plan || activeTrial?.plan || 'Starter';
  const planEntitlement = aiPlanEntitlements[plan] || aiPlanEntitlements.Starter;
  const trialMode = Boolean(activeTrial && !subscription);
  const buildLimit = trialMode ? activeTrial.buildLimit : planEntitlement.buildLimit;
  const quotaKey = trialMode
    ? `trial:${activeTrial._id}`
    : plan === 'Starter'
      ? `starter:${userId}`
      : `subscription:${subscription?._id || plan}`;
  const quota = await AIProjectQuota.findOne({ userId, quotaKey }).lean();
  const buildsUsed = (quota?.successfulBuilds || 0) + (quota?.pendingBuilds || 0);
  const trialView = aiTrialView(trial, now);
  if (activeTrial) trialView.remainingBuilds = Math.max(0, activeTrial.buildLimit - buildsUsed);
  return {
    plan,
    accessType: trialMode ? 'trial' : subscription ? 'paid' : 'starter',
    subscription,
    trialRecord: activeTrial,
    trial: trialView,
    trialMode,
    quotaKey,
    buildLimit,
    buildsUsed,
    remainingBuilds: buildLimit == null ? null : Math.max(0, buildLimit - buildsUsed),
    canBuildProjects: true,
    canAddComponents: trialMode ? ['Premium', 'Exclusive'].includes(plan) : planEntitlement.addComponents,
    canAssistCheckout: trialMode ? plan === 'Exclusive' : planEntitlement.checkoutAssistance,
    trialEligible: !subscription && !trial,
  };
};

const aiAccessResponse = (access, billSummary = null) => ({
  plan: access.plan,
  accessType: access.accessType,
  entitlements: {
    projectBuilder: true,
    buildLimit: access.buildLimit,
    buildsUsed: access.buildsUsed,
    remainingBuilds: access.remainingBuilds,
    bills: billSummary ? {
      includedAllowance: billSummary.includedAllowance,
      includedRemaining: billSummary.includedRemaining,
      purchasedRemaining: billSummary.purchasedRemaining,
      totalAvailable: billSummary.totalAvailable,
      nextAllowanceReset: billSummary.nextAllowanceReset,
    } : null,
    addComponents: access.canAddComponents,
    checkoutAssistance: access.canAssistCheckout,
    trialCashback: false,
  },
  trial: { ...access.trial, eligible: access.trialEligible },
  subscription: access.subscription ? {
    plan: access.subscription.plan,
    startDate: access.subscription.startDate,
    expiryDate: access.subscription.expiryDate,
    status: access.subscription.status,
  } : null,
});

const processAllDueRenewals = async () => {
  if (mongoose.connection.readyState !== 1) return;
  const dueUsers = await Subscription.distinct('userId', { status: 'active', autoRenew: true, expiryDate: { $lte: new Date() } });
  await Promise.all(dueUsers.map((userId) => renewDueSubscriptions(userId)));
};

const getOrderLimit = async () => {
  const setting = await AdminSetting.findOne({ key: 'max_active_orders' }).lean();
  return Number(setting?.value ?? 50);
};

const enforceOrderLimit = async (session) => {
  const maxActive = await getOrderLimit();
  const countQuery = Order.countDocuments({
    orderStatus: { $in: ['Processing', 'Pending Review', 'Accepted', 'Ordered'] },
  });
  const activeCount = session ? await countQuery.session(session) : await countQuery;
  if (activeCount >= maxActive) {
    throw Object.assign(new Error('Orders Temporarily Full. We have currently reached our order capacity. Please try again later.'), { status: 409 });
  }
};

const applyInventoryReduction = async (session, items, { validateProductSnapshot = false } = {}) => {
  const inventoryDeductedAt = new Date();
  for (const item of items || []) {
    if (item.customOrderId || item.discountOfferId) continue;
    const remainingStock = { $subtract: ['$stock', item.quantity] };
    const inventoryQuery = { productId: item.id, stock: { $gte: item.quantity } };
    if (validateProductSnapshot) inventoryQuery.pricePaise = toPaise(item.price);
    const inventory = await InventoryItem.findOneAndUpdate(
      inventoryQuery,
      [{ $set: {
        stock: remainingStock,
        status: { $cond: [{ $gt: [remainingStock, 5] }, 'In Stock', { $cond: [{ $gt: [remainingStock, 0] }, 'Low Stock', 'Out of Stock'] }] },
        updatedAt: inventoryDeductedAt,
      } }],
      { session, returnDocument: 'after', updatePipeline: true },
    ).lean();
    if (!inventory) {
      const message = validateProductSnapshot
        ? `The price or availability for ${item.name} changed during checkout. Review your cart and try again.`
        : `Sorry, ${item.name} is no longer available in the requested quantity.`;
      throw Object.assign(new Error(message), { status: 409 });
    }
  }
  return inventoryDeductedAt;
};

const refundRazorpayPayment = async (paymentId, expectedAmountPaise) => {
  if (!razorpayKeyId || !razorpayKeySecret) throw new Error('Razorpay refund credentials are not configured.');
  const authorization = `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`;
  const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authorization },
  });
  const payment = await paymentResponse.json();
  if (!paymentResponse.ok || payment.amount !== expectedAmountPaise || payment.currency !== 'INR' || !['captured', 'partially_refunded', 'refunded'].includes(payment.status)) {
    throw new Error('The captured payment could not be verified for an automatic refund.');
  }
  const refundAmount = expectedAmountPaise - Number(payment.amount_refunded || 0);
  if (refundAmount <= 0) return { alreadyRefunded: true };
  const refundResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: refundAmount, notes: { reason: 'Inventory unavailable at order confirmation.' } }),
  });
  const refund = await refundResponse.json();
  if (!refundResponse.ok) throw new Error('Razorpay could not process the automatic refund.');
  return { alreadyRefunded: false, refundId: refund.id };
};

const refundRazorpayOrderPayment = async (paymentId, expectedRefundAmountPaise, idempotencyKey, orderId, originalAmountPaise = expectedRefundAmountPaise) => {
  if (!razorpayKeyId || !razorpayKeySecret) throw new Error('Razorpay refund credentials are not configured.');
  const authorization = `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`;
  const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authorization },
  });
  const payment = await paymentResponse.json();
  if (!paymentResponse.ok || payment.currency !== 'INR' || payment.amount !== originalAmountPaise
    || !['captured', 'partially_refunded', 'refunded'].includes(payment.status)) {
    throw new Error('The original Razorpay payment could not be verified for this refund.');
  }
  if (!Number.isSafeInteger(expectedRefundAmountPaise) || expectedRefundAmountPaise <= 0
    || expectedRefundAmountPaise > payment.amount) {
    throw new Error('The requested refund amount exceeds the verified Razorpay payment.');
  }
  const refundsResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100`, {
    headers: { Authorization: authorization },
  });
  const refundsResult = await refundsResponse.json();
  if (!refundsResponse.ok) throw new Error('Razorpay refund status could not be verified.');
  const existing = (refundsResult.items || []).find((refund) => refund.notes?.internal_reference === idempotencyKey);
  if (existing) return { refundId: existing.id, status: existing.status, amountPaise: existing.amount };
  if (expectedRefundAmountPaise > payment.amount - Number(payment.amount_refunded || 0)) {
    throw new Error('The requested refund amount exceeds the verified unrefunded Razorpay payment.');
  }
  if (Number(payment.amount_refunded || 0) !== 0) {
    throw new Error('The payment already has a refund that cannot be matched to this order-decline request. Manual reconciliation is required.');
  }

  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-Razorpay-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      amount: expectedRefundAmountPaise,
      notes: { internal_reference: idempotencyKey, order_id: orderId, cancellation_source: 'ADMIN' },
    }),
  });
  const refund = await response.json();
  if (!response.ok) throw new Error(refund?.error?.description || 'Razorpay could not process the order refund.');
  return { refundId: refund.id, status: refund.status, amountPaise: refund.amount };
};

const restoreInventoryForOrder = async (session, order) => {
  if (!order.inventoryDeductedAt && !order.acceptedAt && order.orderStatus !== 'Accepted') return;
  for (const item of order.items || []) {
    if (item.customOrderId) continue;
    const remainingQuantity = Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0));
    if (!remainingQuantity) continue;
    const restoredStock = { $add: ['$stock', remainingQuantity] };
    await InventoryItem.updateOne(
      { productId: item.id },
      [{ $set: {
        stock: restoredStock,
        status: { $cond: [{ $gt: [restoredStock, 5] }, 'In Stock', { $cond: [{ $gt: [restoredStock, 0] }, 'Low Stock', 'Out of Stock'] }] },
        updatedAt: new Date(),
      } }],
      { session, updatePipeline: true },
    );
  }
  order.inventoryDeductedAt = null;
};

const restoreInventoryForItems = async (session, items) => {
  for (const item of items || []) {
    if (item.customOrderId || item.discountOfferId) continue;
    const restoredStock = { $add: ['$stock', Number(item.quantity || 0)] };
    await InventoryItem.updateOne(
      { productId: item.id },
      [{ $set: {
        stock: restoredStock,
        status: { $cond: [{ $gt: [restoredStock, 5] }, 'In Stock', { $cond: [{ $gt: [restoredStock, 0] }, 'Low Stock', 'Out of Stock'] }] },
        updatedAt: new Date(),
      } }],
      { session, updatePipeline: true },
    );
  }
};

const activateSubscription = async (session, { userId, plan, paymentMethod, paymentReference, durationMonths = 1 }) => {
  if (await currentSubscription(userId, session)) {
    throw Object.assign(new Error('Your current plan remains active until it expires.'), { status: 409 });
  }
  const config = planConfig[plan];
  if (!config || plan === 'Starter') throw Object.assign(new Error('Choose a paid plan.'), { status: 400 });
  const months = subscriptionDurationMonths(durationMonths);
  const totalPricePaise = config.pricePaise * months;
  if (!Number.isSafeInteger(totalPricePaise)) throw Object.assign(new Error('The selected subscription total is invalid.'), { status: 400 });
  const now = new Date();
  const expiryDate = addMonths(now, months);
  const previousState = await getSubscriptionGraceState(userId, session);
  const transactionType = previousState.previousPlan !== 'Starter' && previousState.previousPlan !== plan
    ? 'upgrade'
    : 'purchase';
  const subscription = await Subscription.create([{
    userId,
    plan,
    durationMonths: months,
    monthlyPricePaise: config.pricePaise,
    previousPlan: previousState.previousPlan || 'Starter',
    pricePaise: totalPricePaise,
    startDate: now,
    expiryDate,
    billAllowancePeriodStart: now,
    autoRenew: true,
    status: 'active',
    paymentMethod,
    paymentReference,
    cashbackGranted: config.cashbackPaise > 0,
  }], { session });
  await SubscriptionGraceDismissal.deleteMany({ userId }, { session });
  await ensureAiBillAllowance(userId, session, subscription[0].toObject());
  const cashbackPaise = config.cashbackPaise;
  if (cashbackPaise > 0) {
    const wallet = await Wallet.findOneAndUpdate(
      { userId },
      { $inc: { balancePaise: cashbackPaise }, $setOnInsert: { pinHash: '' } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    );
    if (wallet) {
      const before = wallet.balancePaise - cashbackPaise;
      await WalletTransaction.create([{
        userId,
        type: 'Adjustment',
        amountPaise: cashbackPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `subscription-cashback:${paymentReference}`,
        description: `${displayPlanName(plan)} activation cashback`,
        status: 'Successful',
      }], { session });
    }
  }
  const subscriptionCredits = config.credits * months;
  if (config.credits > 0) {
    await ensureAiCreditBuckets(userId, session);
    if (!Number.isSafeInteger(subscriptionCredits)) throw new Error('Subscription credit allocation is invalid.');
    const credits = await AICredits.findOneAndUpdate(
      { userId },
      {
        $inc: { balance: subscriptionCredits, includedCredits: subscriptionCredits, includedCreditsRemaining: subscriptionCredits },
        $setOnInsert: { purchasedCreditsRemaining: 0, creditBucketsInitialized: true },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    );
    await AICreditTransaction.create([{
      userId,
      type: 'added',
      amount: subscriptionCredits,
      action: `${displayPlanName(plan)} subscription credits (${months} month${months === 1 ? '' : 's'})`,
      reference: `subscription-credits:${paymentReference}`,
      balanceAfter: credits.balance,
    }], { session });
  }
  await SubscriptionTransaction.create([{
    userId,
    orderCategory: 'SUBSCRIPTION_ORDER',
    transactionType,
    plan,
    amountPaise: totalPricePaise,
    creditsAllocated: subscriptionCredits,
    billsAllocated: config.includedAiBills * months,
    durationMonths: months,
    monthlyPricePaise: config.pricePaise,
    subscriptionId: subscription[0]._id,
    orderId: `SUB-${paymentReference}`,
    startDate: now,
    expiryDate,
    paymentMethod,
    paymentReference,
    cashbackPaise,
    status: 'Successful',
  }], { session });
  await syncWalletRestrictionState(userId, session, null);
  await Notification.create([{
    userId,
    message: `${displayPlanName(plan)} plan activated for ${months} month${months === 1 ? '' : 's'}.${cashbackPaise ? ` ₹${money(cashbackPaise)} activation cashback added.` : ''}${config.credits ? ` ${subscriptionCredits.toLocaleString('en-IN')} AI credits added.` : ''}`,
  }], { session });
  await createInvoiceForStandalonePurchase(session, {
    userId,
    orderId: `SUB-${paymentReference}`,
    paymentId: paymentReference,
    paymentMethod,
    itemName: `${displayPlanName(plan)} Membership Plan`,
    amountPaise: totalPricePaise,
  });
  return subscription[0].toObject();
};

const planPaymentResponse = (subscription) => ({
  subscription: {
    id: String(subscription._id),
    plan: subscription.plan,
    durationMonths: subscription.durationMonths || 1,
    monthlyPricePaise: subscription.monthlyPricePaise ?? planConfig[subscription.plan].pricePaise,
    pricePaise: subscription.pricePaise,
    price: money(subscription.pricePaise),
    startDate: subscription.startDate,
    expiryDate: subscription.expiryDate,
    autoRenew: subscription.autoRenew,
    status: subscription.status,
    paymentMethod: subscription.paymentMethod,
    cashbackGranted: subscription.cashbackGranted,
  },
  cashback: money(planConfig[subscription.plan].cashbackPaise),
  credits: planConfig[subscription.plan].credits * Number(subscription.durationMonths || 1),
});

app.get('/api/auth/me', requireDatabase, async (req, res) => {
  let session;
  try {
    session = jwt.verify(req.cookies.innovation_session || '', sessionSecret);
  } catch {
    return res.json({ user: null, requiresAdminVerification: false });
  }
  if (session.jti && (revokedSessionIds.has(session.jti) || await RevokedSession.exists({ sessionId: session.jti }))) {
    return res.json({ user: null, requiresAdminVerification: false });
  }
  const user = await User.findOne({ googleId: session.sub }).lean();
  if (!user) return res.json({ user: null, requiresAdminVerification: false });
  return res.json({ user: {
    id: user.googleId,
    name: user.name,
    email: user.email,
    picture: user.picture || null,
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
    purchaseAgeEligible: isPurchaseAgeEligible(user.dateOfBirth),
    ageVerificationStatus: user.ageVerificationStatus || 'pending',
    accountStatus: user.accountStatus || 'active',
    restrictionReason: user.restrictionReason || '',
    restrictedAt: user.restrictedAt || null,
    isAdmin: session.admin === true && isAdminEmail(user.email),
  }, requiresAdminVerification: isAdminEmail(user.email) && session.admin !== true });
});

app.post('/api/account/age-verification', requireSession, requireDatabase, async (req, res) => {
  const dateOfBirthInput = typeof req.body?.dateOfBirth === 'string' ? req.body.dateOfBirth : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthInput)) {
    return res.status(400).json({ message: 'Enter your date of birth in YYYY-MM-DD format.' });
  }
  const dateOfBirth = new Date(`${dateOfBirthInput}T00:00:00.000Z`);
  if (!Number.isFinite(dateOfBirth.getTime())
    || dateOfBirth.toISOString().slice(0, 10) !== dateOfBirthInput
    || dateOfBirth > new Date()) {
    return res.status(400).json({ message: 'Enter a valid date of birth that is not in the future.' });
  }

  const result = await withMongoTransaction(async (session) => {
    const account = await User.findOne({ googleId: req.session.sub }).session(session);
    if (!account) throw Object.assign(new Error('Your account could not be found.'), { status: 404 });
    if (account.accountStatus === 'restricted' || account.ageVerificationStatus === 'restricted') {
      return { restricted: true, account };
    }

    const now = new Date();
    const eligible = isPurchaseAgeEligible(dateOfBirth, now);
    account.dateOfBirth = dateOfBirth;
    account.purchaseAgeDeclaredAt = now;
    account.ageVerificationStatus = eligible ? 'verified' : 'restricted';
    account.accountStatus = eligible ? 'active' : 'restricted';
    account.ageVerificationDate = eligible ? now : null;
    account.restrictionReason = eligible ? '' : 'Does not meet the minimum age requirement (18 years old).';
    account.restrictedAt = eligible ? null : now;
    await account.save({ session });
    await AgeVerificationEvent.create([{
      userId: account.googleId,
      eventType: eligible ? 'verified' : 'restricted',
      dateOfBirth,
      reason: account.restrictionReason,
      actorUserId: account.googleId,
      createdAt: now,
    }], { session });
    if (!eligible && req.session.jti && req.session.exp) {
      await RevokedSession.updateOne(
        { sessionId: req.session.jti },
        { $setOnInsert: { sessionId: req.session.jti, expiresAt: new Date(req.session.exp * 1000) } },
        { upsert: true, session },
      );
    }
    return { restricted: !eligible, account };
  });

  const account = result.account;
  return res.json({
    dateOfBirth: account.dateOfBirth.toISOString().slice(0, 10),
    ageVerificationStatus: account.ageVerificationStatus,
    accountStatus: account.accountStatus,
    verifiedAt: account.ageVerificationDate || null,
    restrictedAt: account.restrictedAt || null,
    restrictionReason: account.restrictionReason || '',
    accountRestricted: result.restricted,
  });
});

app.get('/api/admin/account-restrictions', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const accounts = await User.find({
    $or: [{ accountStatus: 'restricted' }, { ageVerificationStatus: 'restricted' }],
  }).select('googleId name email dateOfBirth ageVerificationStatus accountStatus restrictionReason restrictedAt')
    .sort({ restrictedAt: -1 }).lean();
  return res.json({
    accounts: accounts.map((account) => ({
      userId: account.googleId,
      name: account.name,
      email: account.email,
      dateOfBirth: account.dateOfBirth?.toISOString().slice(0, 10) || null,
      restrictedAt: account.restrictedAt || null,
      restrictionReason: account.restrictionReason || 'Does not meet the minimum age requirement (18 years old).',
      status: account.accountStatus || 'restricted',
      ageVerificationStatus: account.ageVerificationStatus || 'restricted',
    })),
  });
});

app.patch('/api/admin/account-restrictions/:userId/reactivate', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId || userId.length > 200) return res.status(400).json({ message: 'A valid account ID is required.' });
  const account = await withMongoTransaction(async (session) => {
    const user = await User.findOne({ googleId: userId }).session(session);
    if (!user) throw Object.assign(new Error('The restricted account was not found.'), { status: 404 });
    if (user.accountStatus !== 'restricted' && user.ageVerificationStatus !== 'restricted') {
      throw Object.assign(new Error('This account is no longer restricted.'), { status: 409 });
    }
    const now = new Date();
    const priorReason = user.restrictionReason || 'Does not meet the minimum age requirement (18 years old).';
    user.ageVerificationStatus = 'pending';
    user.accountStatus = 'active';
    user.dateOfBirth = null;
    user.purchaseAgeDeclaredAt = null;
    user.ageVerificationDate = null;
    user.restrictionReason = '';
    user.restrictedAt = null;
    user.reactivationHistory.push({ reactivatedAt: now, reactivatedBy: req.session.sub, previousReason: priorReason });
    await user.save({ session });
    await AgeVerificationEvent.create([{
      userId,
      eventType: 'reactivated',
      reason: priorReason,
      actorUserId: req.session.sub,
      createdAt: now,
    }], { session });
    return user;
  });
  return res.json({
    userId: account.googleId,
    status: account.accountStatus,
    ageVerificationStatus: account.ageVerificationStatus,
    message: 'Account reactivated. The user must sign in and complete age verification before accessing Innovation Labs.',
  });
});

app.patch('/api/account/purchase-age', requireSession, requireDatabase, async (req, res) => {
  const dateOfBirthInput = typeof req.body?.dateOfBirth === 'string' ? req.body.dateOfBirth : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthInput)) {
    return res.status(400).json({ message: 'Enter your date of birth in YYYY-MM-DD format.' });
  }
  const dateOfBirth = new Date(`${dateOfBirthInput}T00:00:00.000Z`);
  if (!Number.isFinite(dateOfBirth.getTime()) || dateOfBirth.toISOString().slice(0, 10) !== dateOfBirthInput || dateOfBirth > new Date()) {
    return res.status(400).json({ message: 'Enter a valid date of birth that is not in the future.' });
  }
  const existing = await User.findOne({ googleId: req.session.sub }).select('dateOfBirth').lean();
  if (!existing) return res.status(404).json({ message: 'Your account could not be found.' });
  if (existing.dateOfBirth && existing.dateOfBirth.toISOString().slice(0, 10) !== dateOfBirthInput) {
    return res.status(409).json({ message: 'A date of birth is already recorded. Contact support if it needs correction.' });
  }
  const updated = await User.findOneAndUpdate(
    { googleId: req.session.sub, $or: [{ dateOfBirth: { $exists: false } }, { dateOfBirth: null }, { dateOfBirth }] },
    { $set: { dateOfBirth, purchaseAgeDeclaredAt: new Date() } },
    { new: true },
  ).select('dateOfBirth').lean();
  if (!updated) return res.status(409).json({ message: 'The date of birth could not be saved. Refresh and try again.' });
  const purchaseAgeEligible = isPurchaseAgeEligible(updated.dateOfBirth);
  return res.json({
    dateOfBirth: updated.dateOfBirth.toISOString().slice(0, 10),
    purchaseAgeEligible,
    message: purchaseAgeEligible ? 'Your purchase-age declaration has been saved.' : 'Purchases are restricted to customers aged 18 or older.',
  });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleClientId || !sessionSecret) {
    return res.status(503).json({ message: 'Google sign-in is not configured on the server.' });
  }
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Google sign-in is unavailable until the database connection is restored.' });
  }

  const { credential, acceptPolicies } = req.body || {};
  if (!credential) return res.status(400).json({ message: 'Google credential is required.' });

  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ message: 'Google account could not be verified.' });
    }

    const user = {
      id: payload.sub,
      name: payload.name || payload.email.split('@')[0],
      email: payload.email,
      picture: payload.picture || null,
      isAdmin: false,
    };
    let account = await User.findOne({ googleId: user.id });
    let created = false;
    if (!account) {
      if (acceptPolicies !== true) {
        return res.status(428).json({
          requiresPolicyConsent: true,
          policyVersion,
          message: 'Accept the Terms & Policies before creating your account.',
        });
      }
      try {
        account = await withMongoTransaction(async (session) => {
          const concurrentAccount = await User.findOne({ googleId: user.id }).session(session);
          if (concurrentAccount) return concurrentAccount;
          const [newAccount] = await User.create([{
            googleId: user.id, name: user.name, email: user.email, picture: user.picture,
          }], { session });
          await PolicyConsent.create([{
            userId: user.id, policyVersion, consentedAt: new Date(),
          }], { session });
          created = true;
          return newAccount;
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        account = await User.findOne({ googleId: user.id });
        if (!account) throw error;
      }
    } else {
      account.name = user.name;
      account.email = user.email;
      account.picture = user.picture;
      await account.save();
    }

    if (account.accountStatus === 'restricted' || account.ageVerificationStatus === 'restricted') {
      return res.status(403).json({
        code: 'ACCOUNT_RESTRICTED',
        message: 'This account is restricted. Contact Innovation Labs support or an administrator for assistance.',
        user: {
          id: account.googleId,
          name: account.name,
          email: account.email,
          picture: account.picture || null,
          ageVerificationStatus: 'restricted',
          accountStatus: 'restricted',
          restrictionReason: account.restrictionReason || '',
          restrictedAt: account.restrictedAt || null,
        },
      });
    }
    createSessionCookie(res, { sub: user.id, email: user.email, name: user.name });
    return res.json({
      user: {
        ...user,
        dateOfBirth: account.dateOfBirth ? account.dateOfBirth.toISOString().slice(0, 10) : null,
        purchaseAgeEligible: isPurchaseAgeEligible(account.dateOfBirth),
        ageVerificationStatus: account.ageVerificationStatus || 'pending',
        accountStatus: account.accountStatus || 'active',
        restrictionReason: account.restrictionReason || '',
        restrictedAt: account.restrictedAt || null,
      },
      created,
      policyVersion: created ? policyVersion : null,
      requiresAdminVerification: isAdminEmail(user.email),
    });
  } catch (error) {
    console.error('Google token verification failed:', error.message);
    return res.status(401).json({ message: 'Google sign-in failed. Please try again.' });
  }
});

app.post('/api/auth/admin/verify', requireSession, requireDatabase, async (req, res) => {
  const email = String(req.session.email || '').trim().toLowerCase();
  if (!isAdminEmail(email)) return res.status(403).json({ message: 'Admin verification is unavailable for this account.' });
  if (!adminPasswordHash || !sessionSecret) return res.status(503).json({ message: 'Admin verification is not configured on the server.' });

  const userId = String(req.session.sub || email);
  const existingAttempt = await AdminVerificationAttempt.findOne({ userId }).lean();
  const now = new Date();
  if (existingAttempt?.lockedUntil && existingAttempt.lockedUntil > now) {
    const retryMinutes = Math.max(1, Math.ceil((existingAttempt.lockedUntil.getTime() - now.getTime()) / 60_000));
    return res.status(429).json({ message: `Two incorrect passwords were entered. Admin sign-in is locked for ${retryMinutes} more minute${retryMinutes === 1 ? '' : 's'}.` });
  }

  const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
  const safePassword = suppliedPassword.length <= 256 ? suppliedPassword : '';
  const suppliedHash = crypto.scryptSync(safePassword, sessionSecret, 64);
  const passwordMatches = suppliedPassword.length <= 256 && crypto.timingSafeEqual(suppliedHash, adminPasswordHash);
  if (!passwordMatches) {
    const attempt = await withMongoTransaction(async (session) => {
      const current = await AdminVerificationAttempt.findOne({ userId }).session(session);
      if (current?.lockedUntil && current.lockedUntil > now) return { lockedUntil: current.lockedUntil, failures: 2 };
      const windowActive = current?.windowStartedAt && now.getTime() - current.windowStartedAt.getTime() < 15 * 60 * 1000;
      const failures = windowActive ? Number(current.failures || 0) + 1 : 1;
      const lockedUntil = failures >= 2 ? new Date(now.getTime() + 15 * 60 * 1000) : null;
      if (current) {
        current.failures = failures;
        current.windowStartedAt = windowActive ? current.windowStartedAt : now;
        current.lockedUntil = lockedUntil;
        await current.save({ session });
      } else {
        await AdminVerificationAttempt.create([{ userId, failures, windowStartedAt: now, lockedUntil }], { session });
      }
      return { failures, lockedUntil };
    });
    if (attempt.lockedUntil) {
      return res.status(429).json({ message: 'Two incorrect passwords were entered. This admin sign-in attempt was cancelled. Try again after the 15-minute security lockout.' });
    }
    return res.status(401).json({ message: 'Incorrect password. One attempt remaining.' });
  }

  await AdminVerificationAttempt.deleteOne({ userId });
  createSessionCookie(res, { sub: req.session.sub, email: req.session.email, name: req.session.name, admin: true });
  return res.json({ user: { id: req.session.sub, name: req.session.name, email: req.session.email, isAdmin: true } });
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const session = jwt.verify(req.cookies.innovation_session || '', sessionSecret);
    if (session.jti) {
      revokedSessionIds.add(session.jti);
      if (mongoose.connection.readyState === 1 && session.exp) {
        await RevokedSession.updateOne(
          { sessionId: session.jti },
          { $setOnInsert: { sessionId: session.jti, expiresAt: new Date(session.exp * 1000) } },
          { upsert: true },
        );
      }
    }
  } catch {
    // Clearing a missing or expired session remains a successful logout.
  }
  res.clearCookie('innovation_session');
  res.clearCookie(walletUnlockCookieName, { path: '/api' });
  res.sendStatus(204);
});

app.get('/api/health/database', async (_req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ database: 'disconnected', errorType: databaseDiagnostic.errorType || 'unavailable' });
  }
  try {
    await mongoose.connection.db.command({ ping: 1 });
    return res.json({ database: 'connected', databaseName: mongoose.connection.name || 'configured database' });
  } catch (error) {
    databaseDiagnostic = { state: 'disconnected', errorType: classifyDatabaseError(error) };
    return res.status(503).json({ database: 'disconnected', errorType: databaseDiagnostic.errorType });
  }
});

app.get('/api/health/payment', (_req, res) => {
  return res.json({
    razorpay: razorpayKeyId && razorpayKeySecret ? 'configured' : 'not_configured',
    serverKeyIdPresent: Boolean(razorpayKeyId),
    serverSecretPresent: Boolean(razorpayKeySecret),
  });
});

app.get('/api/plans', (_req, res) => res.json({ plans: getPlanSummary() }));
app.get('/api/subscription/checkout/:plan', requireSession, requireDatabase, async (req, res) => {
  const plan = String(req.params.plan || '');
  if (!['Medium', 'Premium', 'Exclusive'].includes(plan)) return res.status(400).json({ message: 'Choose an available paid plan.' });
  let durationMonths;
  try { durationMonths = subscriptionDurationMonths(req.query.months); }
  catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
  if (await currentSubscription(req.session.sub)) return res.status(409).json({ message: 'Your current plan remains active until it expires.' });
  const now = new Date();
  const expiryDate = addMonths(now, durationMonths);
  const monthlyPricePaise = planConfig[plan].pricePaise;
  const totalPricePaise = monthlyPricePaise * durationMonths;
  if (!Number.isSafeInteger(totalPricePaise)) return res.status(400).json({ message: 'The selected subscription total is invalid.' });
  const walletState = await getWalletBalanceState(req.session.sub);
  const walletLimit = await getWalletLimitStatus(req.session.sub, walletState.balancePaise);
  return res.json({
    serverNow: now.toISOString(),
    plan,
    monthlyPricePaise,
    monthlyPrice: money(monthlyPricePaise),
    pricePaise: totalPricePaise,
    price: money(totalPricePaise),
    startDate: now.toISOString(),
    expiryDate: expiryDate.toISOString(),
    durationMonths,
    maxDurationMonths: maxSubscriptionDurationMonths,
    wallet: {
      balance: walletLimit.availableBalance,
      totalBalance: money(walletState.balancePaise),
      availableBalance: walletLimit.availableBalance,
      restrictedBalance: walletLimit.restrictedBalance,
      lockedBalance: walletLimit.restrictedBalance,
      walletRecordAvailable: Boolean(walletState.wallet),
      balanceKnown: walletState.balanceKnown,
      ledgerFallback: walletState.ledgerFallback,
    },
  });
});

const notifyBackInStockSubscribers = async (productId, productName) => {
  await withMongoTransaction(async (session) => {
    const subscribers = await BackInStockSubscription.find({ productId, notifiedAt: { $exists: false } }).session(session).lean();
    if (!subscribers.length) return;
    const notifications = [];
    for (const subscriber of subscribers) {
      const claimed = await BackInStockSubscription.findOneAndUpdate(
        { _id: subscriber._id, notifiedAt: { $exists: false } },
        { $set: { notifiedAt: new Date() } },
        { new: true, session },
      ).select('_id').lean();
      if (claimed) notifications.push({
        userId: subscriber.userId,
        type: 'back_in_stock',
        data: { productId },
        message: `${productName} is back in stock.`,
      });
    }
    if (notifications.length) await Notification.create(notifications, { session });
  });
};

app.get('/api/products', requireDatabase, async (_req, res) => {
  const inventory = await InventoryItem.find().sort({ category: 1, name: 1 }).lean();
  const products = inventory.map((item) => ({
    id: item.productId,
    name: item.name,
    category: item.category || 'Other Components',
    price: money(item.pricePaise),
    description: item.description || `${item.name} for electronics and custom projects.`,
    stock: item.stock,
    status: item.status,
    inventoryProduct: true,
    images: Array.isArray(item.images) ? item.images : [],
    technicalSpecs: item.technicalSpecs || {},
    cancellable: item.cancellable !== false,
  }));
  return res.json({ products });
});

const getProductById = async (productId) => {
  const inventoryItem = await InventoryItem.findOne({ productId }).lean();
  if (!inventoryItem) return null;
  return {
    id: productId,
    name: inventoryItem.name,
    category: inventoryItem.category || 'Other Components',
    price: money(inventoryItem.pricePaise),
    description: inventoryItem.description || `${inventoryItem.name} for Arduino prototypes, robotics, and hands-on electronics projects.`,
    stock: inventoryItem.stock,
    status: inventoryItem.status,
    inventoryProduct: true,
    images: (inventoryItem.images || []).filter((image) => typeof image === 'string'),
    technicalSpecs: inventoryItem?.technicalSpecs && typeof inventoryItem.technicalSpecs === 'object' ? inventoryItem.technicalSpecs : {},
    cancellable: inventoryItem.cancellable !== false,
  };
};

const browsingHistoryProductView = async (records) => {
  const productIds = [...new Set(records.map((record) => record.productId))];
  const inventory = await InventoryItem.find({ productId: { $in: productIds } }).lean();
  const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
  return records.map((record) => {
    const item = inventoryById.get(record.productId);
    const available = Boolean(item);
    return {
      productId: record.productId,
      viewedAt: record.viewedAt,
      priceAtView: record.pricePaise == null ? null : money(record.pricePaise),
      product: {
        id: record.productId,
        name: item?.name || record.productName,
        category: item?.category || 'Unavailable',
        price: item ? money(item.pricePaise) : null,
        description: item?.description || (available
          ? `${item.name} for electronics and hands-on projects.`
          : 'This product is no longer available.'),
        stock: item?.stock ?? null,
        status: item?.status || (available ? 'In Stock' : 'Unavailable'),
        inventoryProduct: Boolean(item),
        images: Array.isArray(item?.images) ? item.images : [],
        available,
      },
    };
  });
};

const ensureProductSearchHistoryIndexes = async () => {
  try {
    await ProductSearchHistory.createCollection();
  } catch (error) {
    if (error.code !== 48) throw error;
  }
  const indexes = await ProductSearchHistory.collection.indexes();
  for (const index of indexes) {
    const keys = index.key || {};
    if (index.unique && keys.userId === 1 && keys.normalizedTerm === 1) {
      try {
        await ProductSearchHistory.collection.dropIndex(index.name);
      } catch (error) {
        if (error.code !== 27) throw error;
      }
    }
  }
  await ProductSearchHistory.createIndexes();
};

app.get('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  try {
    const [records, searches] = await Promise.all([
      ProductBrowsingHistory.find({ userId: req.session.sub }).sort({ viewedAt: -1 }).limit(1000).lean(),
      ProductSearchHistory.find({ userId: req.session.sub }).sort({ searchedAt: -1 }).limit(100).lean(),
    ]);
    return res.json({
      history: await browsingHistoryProductView(records),
      searches: searches.map((entry) => ({ id: String(entry._id), term: entry.term, searchedAt: entry.searchedAt })),
    });
  } catch (error) {
    console.error('Could not load product browsing history:', error.message);
    return res.status(500).json({ message: 'Product browsing history could not be loaded.' });
  }
});

app.post('/api/browsing-history/search', requireSession, requireDatabase, async (req, res) => {
  const term = typeof req.body?.term === 'string' ? req.body.term.trim().replace(/\s+/g, ' ') : '';
  if (term.length < 2 || term.length > 100) return res.status(400).json({ message: 'A search term between 2 and 100 characters is required.' });
  const normalizedTerm = term.toLocaleLowerCase('en-IN');
  const searchMinute = Math.floor(Date.now() / 60_000);
  const deduplicationKey = crypto.createHash('sha256').update(`${normalizedTerm}:${searchMinute}`).digest('hex');
  try {
    const saved = await ProductSearchHistory.findOneAndUpdate(
      { userId: req.session.sub, deduplicationKey },
      { $set: { term, normalizedTerm, searchedAt: new Date() }, $setOnInsert: { userId: req.session.sub, deduplicationKey } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select('_id term searchedAt').lean();
    return res.json({ search: { id: String(saved._id), term: saved.term, searchedAt: saved.searchedAt } });
  } catch (error) {
    if (error.code === 11000) {
      const saved = await ProductSearchHistory.findOneAndUpdate(
        { userId: req.session.sub, deduplicationKey },
        { $set: { term, normalizedTerm, searchedAt: new Date() } },
        { new: true },
      ).select('_id term searchedAt').lean();
      if (saved) return res.json({ search: { id: String(saved._id), term: saved.term, searchedAt: saved.searchedAt } });
    }
    console.error('Could not record product search history:', error.message);
    return res.status(503).json({ message: 'Search history could not be recorded.' });
  }
});

app.post('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
  if (!productId || productId.length > 120) return res.status(400).json({ message: 'A valid product ID is required.' });

  try {
    const product = await getProductById(productId);
    if (!product) return res.status(404).json({ message: 'Product was not found.' });
    await ProductBrowsingHistory.findOneAndUpdate(
      { userId: req.session.sub, productId },
      { $set: { productName: product.name, pricePaise: toPaise(product.price), viewedAt: new Date() } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 11000) {
      try {
        const product = await getProductById(productId);
        if (!product) return res.status(404).json({ message: 'Product was not found.' });
        await ProductBrowsingHistory.updateOne(
          { userId: req.session.sub, productId },
          { $set: {
            productName: product.name,
            pricePaise: toPaise(product.price),
            viewedAt: new Date(),
          } },
        );
        return res.json({ success: true });
      } catch (retryError) {
        console.error('Could not record product browsing history:', retryError.message);
        return res.status(500).json({ message: 'Product view could not be recorded.' });
      }
    }
    console.error('Could not record product browsing history:', error.message);
    return res.status(500).json({ message: 'Product view could not be recorded.' });
  }
});

app.post('/api/browsing-history/sync', requireSession, requireDatabase, async (req, res) => {
  const incoming = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : null;
  if (!incoming) return res.status(400).json({ message: 'A browsing history list is required.' });

  const parsed = new Map();
  for (const entry of incoming) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    const viewedAt = new Date(entry?.viewedAt);
    if (!productId || productId.length > 120 || Number.isNaN(viewedAt.getTime()) || viewedAt > new Date()) continue;
    const existing = parsed.get(productId);
    if (!existing || viewedAt > existing.viewedAt) parsed.set(productId, { productId, viewedAt });
  }

  try {
    const productIds = [...parsed.keys()];
    const inventory = await InventoryItem.find({ productId: { $in: productIds } }).select('productId name').lean();
    const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
    const operations = [];
    for (const entry of parsed.values()) {
      const item = inventoryById.get(entry.productId);
      const productName = item?.name;
      if (!productName) continue;
      operations.push({
        updateOne: {
          filter: { userId: req.session.sub, productId: entry.productId },
          update: {
            $set: { productName },
            $max: { viewedAt: entry.viewedAt },
            $setOnInsert: { userId: req.session.sub, productId: entry.productId },
          },
          upsert: true,
        },
      });
    }
    if (operations.length) await ProductBrowsingHistory.bulkWrite(operations, { ordered: false });
    return res.json({ synchronized: operations.length });
  } catch (error) {
    console.error('Could not synchronize product browsing history:', error.message);
    return res.status(500).json({ message: 'Guest browsing history could not be synchronized.' });
  }
});

app.delete('/api/browsing-history/search/:id', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'A valid search history entry is required.' });
  try {
    await ProductSearchHistory.deleteOne({ _id: req.params.id, userId: req.session.sub });
    return res.json({ success: true });
  } catch (error) {
    console.error('Could not remove search history item:', error.message);
    return res.status(500).json({ message: 'Search history item could not be removed.' });
  }
});

app.delete('/api/browsing-history/:productId', requireSession, requireDatabase, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  if (!productId || productId.length > 120) return res.status(400).json({ message: 'A valid product ID is required.' });
  try {
    await ProductBrowsingHistory.deleteOne({ userId: req.session.sub, productId });
    return res.json({ success: true });
  } catch (error) {
    console.error('Could not remove product browsing history item:', error.message);
    return res.status(500).json({ message: 'Product view could not be removed from history.' });
  }
});

app.delete('/api/browsing-history', requireSession, requireDatabase, async (req, res) => {
  const type = req.query.type || 'all';
  if (!['views', 'searches', 'all'].includes(type)) {
    return res.status(400).json({ message: 'History type must be views, searches, or all.' });
  }
  try {
    await withMongoTransaction(async (session) => {
      if (type === 'views' || type === 'all') {
        await ProductBrowsingHistory.deleteMany({ userId: req.session.sub }).session(session);
      }
      if (type === 'searches' || type === 'all') {
        await ProductSearchHistory.deleteMany({ userId: req.session.sub }).session(session);
      }
    });
    return res.json({ success: true });
  } catch (error) {
    console.error('Could not clear product browsing history:', error.message);
    return res.status(500).json({ message: 'Product browsing history could not be cleared.' });
  }
});

const reviewImageType = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
};

const publicReviewView = (review) => ({
  reviewId: review.reviewId,
  customerName: review.customerName,
  rating: review.rating,
  description: review.description,
  verifiedPurchase: review.verifiedPurchase,
  createdAt: review.createdAt,
  images: (review.images || []).map((_image, index) => `/api/product-reviews/${encodeURIComponent(review.reviewId)}/images/${index}`),
});

app.get('/api/products/:productId', requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const rewardRules = await rewardRulesFor(null);
  const rewardEligible = !/plan|membership|subscription|service|delivery|ai credit/i.test(`${product.category || ''} ${product.name || ''}`);
  const rewardPoints = rewardEligible ? pointsForEligibleAmount(toPaise(product.price), rewardRules) : 0;
  const reviews = await ProductReview.find({ productId: product.id, moderationStatus: 'approved' })
    .sort({ createdAt: -1 })
    .select('-images.data')
    .lean();
  const distribution = [5, 4, 3, 2, 1].map((rating) => {
    const count = reviews.filter((review) => review.rating === rating).length;
    return { rating, count, percentage: reviews.length ? Math.round(count * 100 / reviews.length) : 0 };
  });
  const averageRating = reviews.length
    ? Math.round(reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length * 10) / 10
    : 0;
  return res.json({ product, rewardPoints, reviews: reviews.map(publicReviewView), reviewSummary: { averageRating, totalReviews: reviews.length, distribution } });
});

app.get('/api/products/:productId/review-eligibility', requireSession, requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const existingReview = await ProductReview.exists({ userId: req.session.sub, productId: product.id });
  if (existingReview) return res.json({ eligible: false, alreadyReviewed: true, message: 'You have already submitted a review for this product.' });
  const order = await Order.findOne({
    userId: req.session.sub,
    paymentStatus: 'Paid',
    orderStatus: { $nin: ['Cancelled', 'Declined', 'Rejected'] },
    items: { $elemMatch: { id: product.id, customOrderId: { $exists: false }, discountOfferId: { $exists: false } } },
  }).sort({ createdAt: -1 }).select('orderId').lean();
  return res.json(order
    ? { eligible: true, orderId: order.orderId }
    : { eligible: false, alreadyReviewed: false, message: 'You can only review products that you have purchased from Innovation Labs.' });
});

const reviewImageUpload = (req, res, next) => uploadReviewImages.array('images', 5)(req, res, (error) => {
  if (error) return res.status(400).json({ message: error.message || 'Review images could not be uploaded.' });
  return next();
});

app.post('/api/products/:productId/reviews', requireSession, requireDatabase, reviewImageUpload, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  const rating = Number(req.body?.rating);
  const description = String(req.body?.description || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'Choose a star rating from 1 to 5.' });
  if (description.length > 2000) return res.status(400).json({ message: 'Review text must be 2,000 characters or fewer.' });
  const files = req.files || [];
  if (files.some((file) => !reviewImageType(file.buffer))) return res.status(400).json({ message: 'One or more uploaded files are not valid JPEG, PNG, or WebP images.' });
  try {
    const result = await withMongoTransaction(async (session) => {
      const existingReview = await ProductReview.exists({ userId: req.session.sub, productId: product.id }).session(session);
      if (existingReview) throw Object.assign(new Error('You have already submitted a review for this product.'), { status: 409 });
      const order = await Order.findOne({
        userId: req.session.sub,
        paymentStatus: 'Paid',
        orderStatus: { $nin: ['Cancelled', 'Declined', 'Rejected'] },
        items: { $elemMatch: { id: product.id, customOrderId: { $exists: false }, discountOfferId: { $exists: false } } },
      }).sort({ createdAt: -1 }).session(session).lean();
      if (!order) throw Object.assign(new Error('You can only review products that you have purchased from Innovation Labs.'), { status: 403 });
      const user = await User.findOne({ googleId: req.session.sub }).select('name').session(session).lean();
      const [review] = await ProductReview.create([{
        reviewId: `REV-${crypto.randomUUID()}`,
        userId: req.session.sub,
        customerName: user?.name || req.session.name || 'Innovation Labs customer',
        productId: product.id,
        productName: product.name,
        orderId: order.orderId,
        rating,
        description,
        images: files.map((file) => ({
          data: file.buffer,
          contentType: reviewImageType(file.buffer),
          originalName: String(file.originalname || 'review-image').replace(/[\\/"\r\n]/g, '').slice(0, 120),
        })),
        verifiedPurchase: true,
        moderationStatus: 'pending',
      }], { session });
      return review;
    });
    return res.status(201).json({ review: { reviewId: result.reviewId, moderationStatus: result.moderationStatus } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'You have already submitted a review for this product.' });
    throw error;
  }
});

app.get('/api/product-reviews/:reviewId/images/:index', async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4) return res.sendStatus(404);
  const review = await ProductReview.findOne({ reviewId: req.params.reviewId, moderationStatus: 'approved' }).select('images').lean();
  const image = review?.images?.[index];
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', image.contentType);
  return res.send(image.data);
});

app.get('/api/admin/product-reviews', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const reviews = await ProductReview.find().sort({ createdAt: -1 }).select('-images.data').limit(500).lean();
  return res.json({ reviews: reviews.map((review) => ({
    ...publicReviewView(review),
    productId: review.productId,
    productName: review.productName,
    orderId: review.orderId,
    userId: review.userId,
    moderationStatus: review.moderationStatus,
    images: (review.images || []).map((_image, index) => `/api/admin/product-reviews/${encodeURIComponent(review.reviewId)}/images/${index}`),
  })) });
});

app.get('/api/admin/product-reviews/:reviewId/images/:index', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4) return res.sendStatus(404);
  const review = await ProductReview.findOne({ reviewId: req.params.reviewId }).select('images').lean();
  const image = review?.images?.[index];
  if (!image) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', image.contentType);
  return res.send(image.data);
});

app.patch('/api/admin/product-reviews/:reviewId/moderation', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: 'Choose approve or reject.' });
  const review = await ProductReview.findOneAndUpdate(
    { reviewId: req.params.reviewId, moderationStatus: 'pending' },
    { $set: { moderationStatus: status, moderatedBy: req.session.email, moderatedAt: new Date() } },
    { new: true },
  ).select('-images.data').lean();
  if (!review) return res.status(404).json({ message: 'Pending product review was not found.' });
  await Notification.create({
    userId: review.userId,
    type: 'product_review_moderation',
    data: { reviewId: review.reviewId, productId: review.productId, status },
    message: status === 'approved'
      ? `Your review for ${review.productName} was approved and is now public.`
      : `Your review for ${review.productName} was not approved.`,
  });
  return res.json({ review: { reviewId: review.reviewId, moderationStatus: review.moderationStatus } });
});

app.post('/api/products/:productId/back-in-stock', requireSession, requireDatabase, async (req, res) => {
  const product = await getProductById(req.params.productId);
  if (!product) return res.status(404).json({ message: 'Product was not found.' });
  if (product.status !== 'Out of Stock' && !(product.inventoryProduct && Number(product.stock) <= 0)) {
    return res.status(409).json({ message: 'This product is currently in stock.' });
  }
  await BackInStockSubscription.updateOne(
    { productId: product.id, userId: req.session.sub },
    { $setOnInsert: { productId: product.id, userId: req.session.sub, email: req.session.email } },
    { upsert: true },
  );
  return res.status(201).json({ subscribed: true, message: 'We will notify you when this product is back in stock.' });
});

const validateWishlistProduct = async (productType, productId) => {
  if (productType === 'product') {
    const inventoryItem = await InventoryItem.findOne({ productId }).lean();
    if (!inventoryItem) throw Object.assign(new Error('This product is not available to save.'), { status: 404 });
    return true;
  }
  if (productType === 'promo' && mongoose.isValidObjectId(productId)) {
    const promo = await PromoCode.findById(productId).select('_id').lean();
    if (promo) return true;
  }
  if (productType === 'discount-code' && mongoose.isValidObjectId(productId)) {
    const offer = await DiscountCodeOffer.findById(productId).select('_id').lean();
    if (offer) return true;
  }
  throw Object.assign(new Error('This wishlist item is not available.'), { status: 404 });
};

const wishlistProductDetails = async (entries) => {
  const productIds = entries.filter((entry) => entry.productType === 'product').map((entry) => entry.productId);
  const promoIds = entries.filter((entry) => entry.productType === 'promo' && mongoose.isValidObjectId(entry.productId)).map((entry) => entry.productId);
  const discountOfferIds = entries.filter((entry) => entry.productType === 'discount-code' && mongoose.isValidObjectId(entry.productId)).map((entry) => entry.productId);
  const [inventory, promos, discountOffers] = await Promise.all([
    productIds.length ? InventoryItem.find({ productId: { $in: productIds } }).lean() : [],
    promoIds.length ? PromoCode.find({ _id: { $in: promoIds } }).select('_id amountPaise status').lean() : [],
    discountOfferIds.length ? DiscountCodeOffer.find({ _id: { $in: discountOfferIds } }).select('_id name sellingPricePaise availableQuantity active startsAt expiresAt discountType discountValuePaise discountPercent').lean() : [],
  ]);
  const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
  const promoById = new Map(promos.map((promo) => [String(promo._id), promo]));
  const discountOfferById = new Map(discountOffers.map((offer) => [String(offer._id), offer]));
  return entries.map((entry) => {
    if (entry.productType === 'promo') {
      const promo = promoById.get(entry.productId);
      return {
        productId: entry.productId,
        productType: 'promo',
        name: 'Digital Wallet Credit',
        category: 'Promo Code',
        price: promo ? money(promo.amountPaise) : 0,
        availability: promo?.status === 'unused' ? 'In Stock' : 'Unavailable',
        addedAt: entry.addedAt,
      };
    }
    if (entry.productType === 'discount-code') {
      const offer = discountOfferById.get(entry.productId);
      const available = offer && offer.active && offer.startsAt <= new Date() && offer.expiresAt > new Date() && offer.availableQuantity > 0;
      return {
        productId: entry.productId,
        productType: 'discount-code',
        name: offer?.name || 'Discount Promo Code',
        category: 'Discount Promo Code',
        price: offer ? money(offer.sellingPricePaise) : 0,
        availability: available ? 'In Stock' : 'Unavailable',
        stock: offer?.availableQuantity ?? 0,
        image: '',
        addedAt: entry.addedAt,
      };
    }
    const inventoryItem = inventoryById.get(entry.productId);
    return {
      productId: entry.productId,
      productType: 'product',
      name: inventoryItem?.name || 'Product no longer available',
      category: inventoryItem?.category || 'Other Components',
      price: inventoryItem ? money(inventoryItem.pricePaise) : 0,
      availability: inventoryItem?.status || 'Unavailable',
      stock: inventoryItem?.stock ?? null,
      inventoryProduct: Boolean(inventoryItem),
      addedAt: entry.addedAt,
    };
  });
};

app.get('/api/wishlist', requireSession, requireDatabase, async (req, res) => {
  const entries = await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean();
  return res.json({ products: await wishlistProductDetails(entries) });
});

app.post('/api/wishlist/items', requireSession, requireDatabase, async (req, res) => {
  const productType = req.body?.productType;
  const productId = String(req.body?.productId || '').trim();
  if (!['product', 'promo', 'discount-code'].includes(productType) || !productId || productId.length > 120) {
    return res.status(400).json({ message: 'Choose a valid product to add to your wishlist.' });
  }
  await validateWishlistProduct(productType, productId);
  await Wishlist.findOneAndUpdate(
    { userId: req.session.sub, productType, productId },
    { $setOnInsert: { userId: req.session.sub, productType, productId, addedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

app.delete('/api/wishlist/items/:productType/:productId', requireSession, requireDatabase, async (req, res) => {
  if (!['product', 'promo', 'discount-code'].includes(req.params.productType)) return res.status(400).json({ message: 'Wishlist item type is invalid.' });
  await Wishlist.deleteOne({ userId: req.session.sub, productType: req.params.productType, productId: req.params.productId });
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

app.post('/api/wishlist/merge', requireSession, requireDatabase, async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products.slice(0, 100) : [];
  for (const entry of products) {
    const productType = entry?.productType;
    const productId = String(entry?.productId || '').trim();
    if (!['product', 'promo', 'discount-code'].includes(productType) || !productId || productId.length > 120) continue;
    try {
      await validateWishlistProduct(productType, productId);
      await Wishlist.findOneAndUpdate(
        { userId: req.session.sub, productType, productId },
        { $setOnInsert: { userId: req.session.sub, productType, productId, addedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error.code !== 11000 && error.status !== 404) throw error;
    }
  }
  return res.json({ products: await wishlistProductDetails(await Wishlist.find({ userId: req.session.sub }).sort({ addedAt: -1 }).lean()) });
});

const discountOfferView = (offer) => ({
  id: String(offer._id),
  name: offer.name,
  source: offer.source || 'ADMIN',
  sellingPrice: money(offer.sellingPricePaise),
  discountType: offer.discountType,
  discountValue: offer.discountType === 'fixed' ? money(offer.discountValuePaise) : offer.discountPercent,
  discountLabel: offer.discountType === 'fixed' ? `₹${money(offer.discountValuePaise)} off` : `${offer.discountPercent}% off`,
  startsAt: offer.startsAt,
  expiresAt: offer.expiresAt,
  minimumPurchase: money(offer.minimumPurchasePaise || 0),
  availableQuantity: offer.availableQuantity,
});

app.get('/api/discount-offers', requireSession, requireDatabase, async (_req, res) => {
  const now = new Date();
  const offers = await DiscountCodeOffer.find({ active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } }).sort({ createdAt: -1 }).lean();
  return res.json({ offers: offers.map(discountOfferView) });
});

app.get('/api/discount-codes/mine', requireSession, requireDatabase, async (req, res) => {
  const purchases = await PurchasedDiscountCode.find({ userId: req.session.sub, fulfillmentStatus: 'fulfilled' }).sort({ purchasedAt: -1 }).lean();
  return res.json({ discountCodes: purchases.map((purchase) => ({
    purchaseId: purchase.purchaseId,
    code: purchase.code,
    discountType: purchase.discountType,
    discountValue: purchase.discountType === 'fixed' ? money(purchase.discountValuePaise) : purchase.discountPercent,
    discountLabel: purchase.discountType === 'fixed' ? `₹${money(purchase.discountValuePaise)} off` : `${purchase.discountPercent}% off`,
    minimumPurchase: money(purchase.minimumPurchasePaise || 0),
    expiresAt: purchase.expiresAt,
    redemptionCount: purchase.redemptionCount,
    maxRedemptions: purchase.maxRedemptions,
    status: purchase.expiresAt <= new Date() ? 'expired' : purchase.redemptionCount >= purchase.maxRedemptions ? 'redeemed' : 'available',
    isScratchReward: purchase.isScratchReward,
    orderId: purchase.orderId,
  })) });
});

app.post('/api/discount-codes/validate', requireSession, requireDatabase, async (req, res) => {
  try {
    const { safeItems } = await resolveOrderItems(req.body?.items, req.session.sub);
    const context = await discountCodeContext({ session: null, userId: req.session.sub, code: req.body?.code, items: safeItems });
    return res.json({
      valid: true,
      code: context.code,
      eligibleAmount: money(context.eligibleAmountPaise),
      discountAmount: money(context.discountAmountPaise),
      discountLabel: context.purchase.discountType === 'fixed' ? `₹${money(context.discountAmountPaise)} off` : `${context.purchase.discountPercent}% off`,
      offerName: context.offer?.name || 'Scratch Card Reward',
    });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'Invalid promo code. Please check your code and try again.', code: error.code || 'DISCOUNT_INVALID' });
  }
});

app.post('/api/discount-offers/:id/purchase-wallet', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  const { pin, idempotencyKey, recipientEmail } = req.body || {};
  if (!validatePin(pin) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A Wallet PIN and valid purchase reference are required.' });
  try {
    const result = await withMongoTransaction(async (session) => purchaseDiscountOffer(session, {
      offerId: req.params.id,
      userId: req.session.sub,
      userName: req.session.name || req.session.email.split('@')[0],
      userEmail: req.session.email,
      recipientEmail,
      paymentMethod: 'Wallet',
      idempotencyKey,
      pin,
    }));
    return res.status(result.duplicate ? 200 : 201).json({ order: result.order, purchase: result.purchase, wallet: { balance: money(walletAvailableBalancePaise(result.wallet)) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This discount-code payment has already been processed.' });
    throw error;
  }
});

app.post('/api/discount-offers/:id/razorpay/order', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  const { idempotencyKey, recipientEmail } = req.body || {};
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase reference is required.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for discount-code purchases.' });
  const previous = await DiscountPurchaseIntent.findOne({ userId: req.session.sub, idempotencyKey }).lean();
  if (previous) {
    if (String(previous.offerId) !== req.params.id) return res.status(409).json({ message: 'This purchase reference is already attached to a different discount offer.' });
    return res.json({ orderId: previous.razorpayOrderId, keyId: razorpayKeyId, amountPaise: previous.amountPaise, offerId: String(previous.offerId) });
  }
  const now = new Date();
  const offer = await DiscountCodeOffer.findOne({ _id: req.params.id, active: true, startsAt: { $lte: now }, expiresAt: { $gt: now }, availableQuantity: { $gt: 0 } }).lean();
  if (!offer) return res.status(409).json({ message: 'This discount offer is no longer available.' });
  const subscriptionDiscount = await subscriptionDiscountForAmount(req.session.sub, offer.sellingPricePaise);
  const payableAmountPaise = Math.max(0, offer.sellingPricePaise - subscriptionDiscount.amountPaise);
  let recipient;
  try {
    recipient = await resolveDiscountRecipient(null, req.session.sub, req.session.email, recipientEmail);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
  try {
    const providerResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: payableAmountPaise, currency: 'INR', receipt: `discount-${req.session.sub}-${Date.now()}` }),
    });
    const providerOrder = await providerResponse.json();
    if (!providerResponse.ok) return res.status(502).json({ message: 'Razorpay could not create the discount purchase payment.' });
    await DiscountPurchaseIntent.create({
      razorpayOrderId: providerOrder.id,
      userId: req.session.sub,
      assignedUserId: recipient.userId,
      recipientEmail: recipient.gift ? recipient.email : undefined,
      offerId: offer._id,
      amountPaise: payableAmountPaise,
      baseAmountPaise: offer.sellingPricePaise,
      subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
      subscriptionDiscountPlan: subscriptionDiscount.plan,
      subscriptionDiscountPercent: subscriptionDiscount.percentage,
      idempotencyKey,
    });
    return res.json({ orderId: providerOrder.id, keyId: razorpayKeyId, amountPaise: payableAmountPaise, offerId: String(offer._id) });
  } catch (error) {
    if (error.code === 11000) {
      const winner = await DiscountPurchaseIntent.findOne({ userId: req.session.sub, idempotencyKey }).lean();
      if (winner && String(winner.offerId) === req.params.id) return res.json({ orderId: winner.razorpayOrderId, keyId: razorpayKeyId, amountPaise: winner.amountPaise, offerId: String(winner.offerId) });
    }
    return res.status(503).json({ message: 'Discount purchase payment is temporarily unavailable.' });
  }
});

app.post('/api/discount-offers/:id/razorpay/verify', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const paymentId = req.body?.razorpay_payment_id;
  const orderId = req.body?.razorpay_order_id;
  const signature = req.body?.razorpay_signature;
  if (!paymentId || !orderId || !signature || !razorpayKeySecret) return res.status(400).json({ message: 'Payment verification details are incomplete.' });
  const expected = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).json({ message: 'Discount-code payment verification failed.' });
  const intent = await DiscountPurchaseIntent.findOne({ razorpayOrderId: orderId, userId: req.session.sub, offerId: req.params.id }).lean();
  if (!intent) return res.status(404).json({ message: 'Discount purchase payment was not found.' });
  if (intent.status === 'paid' && intent.orderId) {
    const [order, purchase] = await Promise.all([Order.findOne({ orderId: intent.orderId, userId: req.session.sub }).lean(), PurchasedDiscountCode.findOne({ orderId: intent.orderId }).lean()]);
    return res.json({ order, purchase, duplicate: true });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay verification is not configured.' });
  try {
    const providerResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    const payment = await providerResponse.json();
    if (!providerResponse.ok || payment.order_id !== orderId || payment.amount !== intent.amountPaise || payment.currency !== 'INR' || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or capture status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const currentIntent = await DiscountPurchaseIntent.findOne({ _id: intent._id, status: 'pending' }).session(session);
      if (!currentIntent) {
        const previous = await Order.findOne({ razorpayId: paymentId, userId: req.session.sub }).session(session).lean();
        if (previous) return { order: previous, purchase: await PurchasedDiscountCode.findOne({ orderId: previous.orderId }).session(session).lean(), duplicate: true };
        throw Object.assign(new Error('This discount purchase payment has already been processed.'), { status: 409 });
      }
      const offer = await DiscountCodeOffer.findById(currentIntent.offerId).session(session).lean();
      if (!offer) throw Object.assign(new Error('Discount offer was not found.'), { status: 404 });
      const purchased = await purchaseDiscountOffer(session, {
        offerId: String(currentIntent.offerId),
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        recipientEmail: currentIntent.recipientEmail,
        paymentMethod: 'Razorpay',
        paymentId,
        idempotencyKey: currentIntent.idempotencyKey,
        expectedAmountPaise: currentIntent.amountPaise,
      });
      currentIntent.status = 'paid';
      currentIntent.paymentId = paymentId;
      currentIntent.orderId = purchased.order.orderId;
      await currentIntent.save({ session });
      return purchased;
    });
    return res.json({ order: result.order, purchase: result.purchase, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) {
      try {
        await refundRazorpayPayment(paymentId, intent.amountPaise);
        await DiscountPurchaseIntent.updateOne({ _id: intent._id, status: 'pending' }, { $set: { status: 'refunded', paymentId } });
        return res.status(error.status).json({ message: `${error.message} The captured payment was refunded.` });
      } catch (refundError) {
        return res.status(409).json({ message: `${error.message} Automatic refund failed: ${refundError.message}` });
      }
    }
    if (error.code === 11000) return res.status(409).json({ message: 'This discount purchase has already been completed.' });
    throw error;
  }
});

app.post('/api/promotion/claim', requireSession, requireDatabase, async (req, res) => {
  const user = await User.findOne({ googleId: req.session.sub }).select('promoEligibleAt').lean();
  if (!user?.promoEligibleAt || user.promoEligibleAt > new Date()) return res.json({ eligible: false });
  const now = new Date();
  const rollingDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const state = await PromotionState.findOneAndUpdate(
    { userId: req.session.sub },
    { $setOnInsert: { userId: req.session.sub } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const recentShows = state.shownAt.filter((date) => date > rollingDay);
  if (recentShows.length >= 4) return res.json({ eligible: false, nextEligibleAt: new Date(recentShows[0].getTime() + 24 * 60 * 60 * 1000) });
  if (state.lastShownAt && now - state.lastShownAt < 60 * 60 * 1000) {
    return res.json({ eligible: false, nextEligibleAt: new Date(state.lastShownAt.getTime() + 60 * 60 * 1000) });
  }
  state.shownAt = [...recentShows, now];
  state.lastShownAt = now;
  await state.save();
  return res.json({ eligible: true, plan: 'Exclusive' });
});

app.get('/api/subscription', requireSession, requireDatabase, async (req, res) => {
  const graceState = await getSubscriptionGraceState(req.session.sub);
  const [access, history, transactions, credits] = await Promise.all([
    getAiAccess(req.session.sub),
    Subscription.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(20).lean(),
    SubscriptionTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(20).lean(),
    AICredits.findOne({ userId: req.session.sub }).lean(),
  ]);
  const wallet = await syncWalletRestrictionState(req.session.sub);
  const walletState = await getWalletBalanceState(req.session.sub);
  const walletBalancePaise = walletState.balancePaise;
  const walletLimit = await getWalletLimitStatus(req.session.sub, walletBalancePaise);
  const graceDismissal = graceState.graceActive
    ? await SubscriptionGraceDismissal.findOne({
      userId: req.session.sub,
      gracePeriodId: graceState.gracePeriodId,
    }).select('dismissalCount').lean()
    : null;
  const current = access.subscription
    ? planPaymentResponse(access.subscription).subscription
    : access.trial.active
      ? {
        id: `trial:${access.trialRecord._id}`,
        plan: access.trial.plan,
        price: 0,
        startDate: access.trial.activatedAt,
        expiryDate: access.trial.expiresAt,
        autoRenew: false,
        status: 'active',
        paymentMethod: 'Trial',
        cashbackGranted: false,
        isTrial: true,
        buildLimit: access.trial.buildLimit,
        successfulBuilds: access.trial.successfulBuilds,
        remainingBuilds: access.remainingBuilds,
      }
      : { plan: 'Starter', status: 'active', autoRenew: false, isTrial: false };
  const now = new Date();
  const expiryDate = current?.expiryDate ? new Date(current.expiryDate) : null;
  const remainingUntilExpiryMs = expiryDate ? expiryDate.getTime() - now.getTime() : 0;
  const warning = graceState.graceActive
    ? {
      stage: 'expired-grace',
      previousPlan: graceState.previousPlan,
      currentPlan: 'Starter',
      expiryDate: graceState.expiryDate || graceState.graceStartedAt,
      startedAt: graceState.graceStartedAt,
      endsAt: graceState.graceEndsAt,
      gracePeriodId: graceState.gracePeriodId,
      dismissalCount: Number(graceDismissal?.dismissalCount || 0),
      popupSuppressed: Number(graceDismissal?.dismissalCount || 0) >= 2,
      remainingMs: graceState.remainingGraceMs,
      walletBalance: walletState.balanceKnown ? money(walletBalancePaise) : null,
      walletLimit: money(walletLimit.maximumBalancePaise),
      amountToLock: walletState.balanceKnown ? money(walletLimit.amountAboveLimitPaise) : null,
      availableAfterGrace: walletState.balanceKnown ? money(Math.min(walletBalancePaise, walletLimit.maximumBalancePaise)) : null,
    }
    : current?.plan !== 'Starter' && !current?.isTrial && remainingUntilExpiryMs > 0 && remainingUntilExpiryMs <= 48 * 60 * 60 * 1000
      ? {
        stage: 'expiring',
        plan: current.plan,
        expiryDate,
        remainingMs: remainingUntilExpiryMs,
      }
      : null;
  return res.json({
    serverNow: now.toISOString(),
    current,
    trial: { ...access.trial, eligible: access.trialEligible },
    history,
    grace: graceState.graceActive ? {
      previousPlan: graceState.previousPlan,
      currentPlan: 'Starter',
      startedAt: graceState.graceStartedAt,
      endsAt: graceState.graceEndsAt,
      gracePeriodId: graceState.gracePeriodId,
      dismissalCount: Number(graceDismissal?.dismissalCount || 0),
      popupSuppressed: Number(graceDismissal?.dismissalCount || 0) >= 2,
      remainingMs: graceState.remainingGraceMs,
      active: true,
      amountToLock: walletState.balanceKnown ? money(walletLimit.amountAboveLimitPaise) : null,
      walletBalance: walletState.balanceKnown ? money(walletBalancePaise) : null,
      walletLimit: money(walletLimit.maximumBalancePaise),
    } : {
      previousPlan: graceState.previousPlan,
      currentPlan: 'Starter',
      startedAt: graceState.graceStartedAt,
      endsAt: graceState.graceEndsAt,
      remainingMs: 0,
      active: false,
      amountToLock: walletState.balanceKnown ? 0 : null,
      walletBalance: walletState.balanceKnown ? money(walletBalancePaise) : null,
      walletLimit: money(walletLimit.maximumBalancePaise),
    },
    warning,
    wallet: {
      balance: walletState.balanceKnown ? money(walletBalancePaise) : null,
      availableBalance: walletLimit.availableBalance,
      lockedBalance: walletLimit.restrictedBalance,
      limit: walletLimit.maximumBalance,
      restrictionActive: walletLimit.restrictionActive,
      walletRecordAvailable: Boolean(walletState.wallet),
      ledgerFallback: walletState.ledgerFallback,
    },
    transactions: transactions.map((item) => ({ ...item, amount: money(item.amountPaise), cashback: money(item.cashbackPaise) })),
    credits: credits ? { balance: credits.balance, includedCredits: credits.includedCredits, purchasedCredits: credits.purchasedCredits, usedCredits: credits.usedCredits } : { balance: 0, includedCredits: 0, purchasedCredits: 0, usedCredits: 0 },
  });
});

app.post('/api/subscription/grace/dismiss', requireSession, requireDatabase, async (req, res) => {
  const graceState = await getSubscriptionGraceState(req.session.sub);
  if (!graceState.graceActive || !graceState.gracePeriodId || !graceState.graceStartedAt) {
    return res.status(409).json({ message: 'There is no active subscription grace-period popup to dismiss.' });
  }
  const subscriptionId = graceState.gracePeriodId.split(':')[0];
  let dismissal;
  try {
    dismissal = await SubscriptionGraceDismissal.findOneAndUpdate(
      {
        userId: req.session.sub,
        gracePeriodId: graceState.gracePeriodId,
        $or: [
          { dismissalCount: { $lt: 2 } },
          { dismissalCount: { $exists: false } },
        ],
      },
      {
        $setOnInsert: {
          userId: req.session.sub,
          gracePeriodId: graceState.gracePeriodId,
          subscriptionId,
          graceStartedAt: graceState.graceStartedAt,
        },
        $inc: { dismissalCount: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: false },
    ).lean();
  } catch (error) {
    if (error.code !== 11000) {
      console.error('Subscription grace popup dismissal could not be saved:', error.message);
      throw error;
    }
    dismissal = await SubscriptionGraceDismissal.findOne({
      userId: req.session.sub,
      gracePeriodId: graceState.gracePeriodId,
    }).select('dismissalCount').lean();
    if (!dismissal) {
      console.error('Subscription grace popup dismissal conflicted but no record exists.');
      throw error;
    }
  }
  return res.json({
    dismissalCount: Number(dismissal.dismissalCount || 0),
    popupSuppressed: Number(dismissal.dismissalCount || 0) >= 2,
    gracePeriodId: graceState.gracePeriodId,
  });
});

app.patch('/api/subscription/auto-renew', requireSession, requireDatabase, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'Choose whether auto-renew is on or off.' });
  const subscription = await currentSubscription(req.session.sub);
  if (!subscription) return res.status(404).json({ message: 'There is no active paid plan to update.' });
  const updated = await Subscription.findOneAndUpdate(
    { _id: subscription._id, status: 'active' },
    { $set: { autoRenew: req.body.enabled } },
    { new: true },
  ).lean();
  return res.json({ subscription: planPaymentResponse(updated).subscription });
});

app.post('/api/subscription/wallet', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const plan = String(req.body?.plan || '');
  const pin = req.body?.pin;
  const idempotencyKey = req.body?.idempotencyKey;
  let durationMonths;
  try { durationMonths = subscriptionDurationMonths(req.body?.durationMonths); }
  catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
  if (!['Medium', 'Premium', 'Exclusive'].includes(plan)) return res.status(400).json({ message: 'Choose an available paid plan.' });
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN in the secure payment field.' });
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid payment reference is required.' });
  const config = planConfig[plan];
  const totalPricePaise = config.pricePaise * durationMonths;
  if (!Number.isSafeInteger(totalPricePaise)) return res.status(400).json({ message: 'The selected subscription total is invalid.' });
  const paymentReference = `wallet-subscription:${idempotencyKey}`;
  const alreadyProcessed = await SubscriptionTransaction.findOne({
    userId: req.session.sub,
    paymentReference,
  }).lean();
  if (alreadyProcessed) {
    const existing = await Subscription.findOne({
      userId: req.session.sub,
      paymentReference,
    }).lean();
    if (!existing || existing.plan !== plan || Number(existing.durationMonths || 1) !== durationMonths) {
      return res.status(409).json({ message: 'This payment reference has already been used.' });
    }
    const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
    return res.json({
      ...planPaymentResponse(existing),
      walletBalance: money(walletAvailableBalancePaise(wallet)),
      duplicate: true,
    });
  }
  const now = new Date();
  const pinWallet = await Wallet.findOne({ userId: req.session.sub })
    .select('pinHash failedPinAttempts lockedUntil balancePaise restrictedBalancePaise')
    .lean();
  if (!pinWallet || !pinWallet.pinHash) {
    return res.status(409).json({ message: 'Set up your Wallet PIN before paying with Wallet.' });
  }
  if (pinWallet.lockedUntil && pinWallet.lockedUntil > now) {
    return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
  }
  const walletLimit = await getWalletLimitStatus(req.session.sub, pinWallet.balancePaise);
  const availableBalancePaise = Number(walletLimit.availableBalancePaise ?? walletAvailableBalancePaise(pinWallet));
  if (availableBalancePaise < totalPricePaise) {
    return res.status(402).json({
      message: `Insufficient Wallet Balance! Available: ₹${money(availableBalancePaise)}. Required: ₹${money(totalPricePaise)}.`,
      availableBalance: money(availableBalancePaise),
      availableBalancePaise,
      requiredAmountPaise: totalPricePaise,
    });
  }
  if (!verifyPin(pin, pinWallet.pinHash)) {
    const nextFailureCount = { $add: [{ $ifNull: ['$failedPinAttempts', 0] }, 1] };
    const shouldLock = { $gte: [nextFailureCount, 5] };
    const failedAttempt = await Wallet.findOneAndUpdate(
      {
        _id: pinWallet._id,
        pinHash: pinWallet.pinHash,
        $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
      },
      [{
        $set: {
          failedPinAttempts: { $cond: [shouldLock, 0, nextFailureCount] },
          lockedUntil: { $cond: [shouldLock, new Date(now.getTime() + 5 * 60 * 1000), '$lockedUntil'] },
        },
      }],
      { new: true },
    ).select('lockedUntil').lean();
    if (!failedAttempt) {
      return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
    }
    if (failedAttempt.lockedUntil && failedAttempt.lockedUntil > now) {
      return res.status(429).json({ message: 'Too many incorrect PIN attempts. Wallet payments are locked for 5 minutes.' });
    }
    return res.status(401).json({ message: 'Incorrect Wallet PIN. Please try again.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet || !wallet.pinHash) throw Object.assign(new Error('Set up your Wallet PIN before paying with Wallet.'), { status: 409 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) {
        throw Object.assign(new Error('Wallet security verification is temporarily locked. Please try again later.'), { status: 429 });
      }
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Wallet PIN changed during verification. Please try again.'), { status: 401 });
      const duplicate = await SubscriptionTransaction.findOne({ userId: req.session.sub, paymentReference }).session(session).lean();
      if (duplicate) {
        const existing = await Subscription.findOne({ userId: req.session.sub, paymentReference }).session(session).lean();
        if (existing && existing.plan === plan && Number(existing.durationMonths || 1) === durationMonths) return existing;
        throw Object.assign(new Error('This payment reference has already been used.'), { status: 409 });
      }
      const currentWalletLimit = await getWalletLimitStatus(req.session.sub, wallet.balancePaise, session);
      const currentAvailableBalancePaise = Number(
        currentWalletLimit.availableBalancePaise ?? walletAvailableBalancePaise(wallet),
      );
      if (currentAvailableBalancePaise < totalPricePaise) {
        throw Object.assign(new Error(
          `Insufficient Wallet Balance! Available: ₹${money(currentAvailableBalancePaise)}. Required: ₹${money(totalPricePaise)}.`,
        ), {
          status: 402,
          availableBalance: money(currentAvailableBalancePaise),
          availableBalancePaise: currentAvailableBalancePaise,
          requiredAmountPaise: totalPricePaise,
        });
      }
      await assertWalletSpendAvailable(req.session.sub, wallet, totalPricePaise, session);
      if (await currentSubscription(req.session.sub, session)) throw Object.assign(new Error('Your current plan remains active until it expires.'), { status: 409 });
      const before = wallet.balancePaise;
      wallet.balancePaise -= totalPricePaise;
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = null;
      await wallet.save({ session });
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -totalPricePaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: paymentReference,
        description: `${displayPlanName(plan)} subscription (${durationMonths} month${durationMonths === 1 ? '' : 's'})`,
        status: 'Successful',
      }], { session });
      return activateSubscription(session, { userId: req.session.sub, plan, paymentMethod: 'Wallet', paymentReference, durationMonths });
    });
    const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
    return res.status(201).json({ ...planPaymentResponse(result), walletBalance: money(walletAvailableBalancePaise(wallet)) });
  } catch (error) {
    if (error.status) {
      const response = { message: error.message };
      if (error.availableBalance != null) response.availableBalance = error.availableBalance;
      if (error.availableBalancePaise != null) response.availableBalancePaise = error.availableBalancePaise;
      if (error.requiredAmountPaise != null) response.requiredAmountPaise = error.requiredAmountPaise;
      return res.status(error.status).json(response);
    }
    if (error.code === 11000) return res.status(409).json({ message: 'This subscription payment has already been processed.' });
    throw error;
  }
});

app.post('/api/subscription/razorpay/order', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const plan = String(req.body?.plan || '');
  let durationMonths;
  try { durationMonths = subscriptionDurationMonths(req.body?.durationMonths); }
  catch (error) { return res.status(error.status || 400).json({ message: error.message }); }
  if (!['Medium', 'Premium', 'Exclusive'].includes(plan)) return res.status(400).json({ message: 'Choose an available paid plan.' });
  if (await currentSubscription(req.session.sub)) return res.status(409).json({ message: 'Your current plan remains active until it expires.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for subscriptions.' });
  const amountPaise = planConfig[plan].pricePaise * durationMonths;
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) return res.status(400).json({ message: 'The selected subscription total is invalid.' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `plan-${req.session.sub}-${Date.now()}` }),
    });
    const order = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the subscription payment.' });
    await PlanPayment.create({ orderId: order.id, userId: req.session.sub, plan, amountPaise, durationMonths, status: 'pending' });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise, plan, durationMonths });
  } catch {
    return res.status(503).json({ message: 'Subscription payment is temporarily unavailable.' });
  }
});

app.post('/api/subscription/razorpay/verify', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') return res.status(400).json({ message: 'Payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for subscriptions.' });
  if (!/^[\da-f]{64}$/i.test(signature)) return res.status(401).json({ message: 'Subscription payment verification failed.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest();
  const suppliedSignature = Buffer.from(signature, 'hex');
  if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(expectedSignature, suppliedSignature)) {
    return res.status(401).json({ message: 'Subscription payment verification failed.' });
  }
  const pending = await PlanPayment.findOne({ orderId, userId: req.session.sub }).lean();
  if (!pending) return res.status(404).json({ message: 'Subscription payment was not found.' });
  if (pending.status === 'paid') {
    const existing = await Subscription.findOne({ userId: req.session.sub, paymentReference: paymentId }).lean();
    return existing ? res.json(planPaymentResponse(existing)) : res.status(409).json({ message: 'Subscription payment has already been processed.' });
  }
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await response.json();
    if (!response.ok || payment.amount !== pending.amountPaise || payment.currency !== 'INR' || payment.order_id !== orderId || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Payment verification is temporarily unavailable.' });
  }
  try {
    const subscription = await withMongoTransaction(async (session) => {
      const claimed = await PlanPayment.findOneAndUpdate({ orderId, userId: req.session.sub, status: 'pending' }, { $set: { status: 'paid', paymentId } }, { new: true, session });
      if (!claimed) throw Object.assign(new Error('Subscription payment has already been processed.'), { status: 409 });
      return activateSubscription(session, { userId: req.session.sub, plan: pending.plan, paymentMethod: 'Razorpay', paymentReference: paymentId, durationMonths: pending.durationMonths || 1 });
    });
    return res.json(planPaymentResponse(subscription));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment has already been applied.' });
    throw error;
  }
});

app.post('/api/credits/purchase', requireSession, requireDatabase, requirePurchaseAge, requireActiveExclusiveCreditAccess, async (req, res) => {
  const paymentMethod = req.body?.paymentMethod;
  if (!['Wallet', 'Razorpay'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Online Payment.' });
  let credits;
  try {
    credits = validateCreditQuantity(req.body?.credits);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
  const idempotencyKey = req.body?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase reference is required.' });
  const baseAmountPaise = credits * aiCreditPricePaise;
  const subscriptionDiscount = await subscriptionDiscountForAmount(req.session.sub, baseAmountPaise);
  let purchase = await CreditPurchase.findOne({ userId: req.session.sub, idempotencyKey });
  if (purchase) {
    if (purchase.credits !== credits || purchase.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'This purchase reference is already used for a different credit purchase.' });
    return res.json({ purchase: creditPurchaseView(purchase) });
  }
  try {
    [purchase] = await CreditPurchase.create([{
      purchaseId: `CRD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      userId: req.session.sub,
      idempotencyKey,
      credits,
      pricePerCreditPaise: aiCreditPricePaise,
      baseAmountPaise,
      totalAmountPaise: Math.max(0, baseAmountPaise - subscriptionDiscount.amountPaise),
      subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
      subscriptionDiscountPlan: subscriptionDiscount.plan,
      subscriptionDiscountPercent: subscriptionDiscount.percentage,
      paymentMethod,
      authorizedPlan: 'Exclusive',
      status: 'pending',
    }]);
  } catch (error) {
    if (error.code !== 11000) throw error;
    purchase = await CreditPurchase.findOne({ userId: req.session.sub, idempotencyKey });
    if (!purchase || purchase.credits !== credits || purchase.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'This purchase reference is already in use.' });
    return res.json({ purchase: creditPurchaseView(purchase) });
  }
  return res.status(201).json({ purchase: creditPurchaseView(purchase) });
});

app.get('/api/credits/purchase/:purchaseId', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const purchase = await CreditPurchase.findOne({ purchaseId: req.params.purchaseId, userId: req.session.sub }).lean();
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
  const credits = await AICredits.findOne({ userId: req.session.sub }).select('balance').lean();
  return res.json({
    purchase: creditPurchaseView(purchase),
    walletBalance: hasWalletUnlock(req) ? money(walletAvailableBalancePaise(wallet)) : null,
    creditBalance: credits?.balance || 0,
  });
});

app.post('/api/credits/wallet/confirm', requireSession, requireDatabase, requirePurchaseAge, requireExclusiveCreditAccess, async (req, res) => {
  const { purchaseId, pin } = req.body || {};
  if (typeof purchaseId !== 'string' || !validatePin(pin)) return res.status(400).json({ message: 'Credit purchase and 4-digit Wallet PIN are required.' });
  const walletSnapshot = await Wallet.findOne({ userId: req.session.sub }).select('pinHash failedPinAttempts lockedUntil').lean();
  if (!walletSnapshot?.pinHash) return res.status(409).json({ message: 'Create your wallet PIN before purchasing credits.' });
  if (walletSnapshot.lockedUntil && walletSnapshot.lockedUntil > new Date()) return res.status(429).json({ message: 'Wallet PIN is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, walletSnapshot.pinHash)) {
    const failedPinAttempts = (walletSnapshot.failedPinAttempts || 0) + 1;
    await Wallet.updateOne(
      { userId: req.session.sub, pinHash: walletSnapshot.pinHash, failedPinAttempts: walletSnapshot.failedPinAttempts || 0 },
      { $set: { failedPinAttempts: failedPinAttempts >= 5 ? 0 : failedPinAttempts, lockedUntil: failedPinAttempts >= 5 ? new Date(Date.now() + 10 * 60 * 1000) : walletSnapshot.lockedUntil || null } },
    );
    return res.status(401).json({ message: 'Incorrect PIN. Payment was not completed.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const purchase = await CreditPurchase.findOne({ purchaseId, userId: req.session.sub }).session(session);
      if (!purchase) throw Object.assign(new Error('Credit purchase was not found.'), { status: 404 });
      if (purchase.status === 'completed') {
        const balance = await AICredits.findOne({ userId: req.session.sub }).session(session).lean();
        return { purchase, balance: balance?.balance || purchase.newBalance || 0, duplicate: true };
      }
      if (purchase.paymentMethod !== 'Wallet' || !['pending', 'processing'].includes(purchase.status)) throw Object.assign(new Error('This credit purchase is no longer payable.'), { status: 409 });
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet?.pinHash) throw Object.assign(new Error('Create your wallet PIN before purchasing credits.'), { status: 409 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet PIN is temporarily locked. Please try again later.'), { status: 429 });
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Wallet PIN changed during payment. Please try again.'), { status: 401 });
      await assertWalletSpendAvailable(req.session.sub, wallet, purchase.totalAmountPaise, session);
      if (wallet.balancePaise < purchase.totalAmountPaise) throw Object.assign(new Error(`Insufficient wallet balance. Required: ${money(purchase.totalAmountPaise)}. Available: ${money(wallet.balancePaise)}.`), { status: 402 });
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = null;
      const before = wallet.balancePaise;
      wallet.balancePaise -= purchase.totalAmountPaise;
      await wallet.save({ session });
      const referenceId = `credit-purchase:${purchase.purchaseId}`;
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -purchase.totalAmountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `AI credit purchase ${purchase.purchaseId}`,
        status: 'Successful',
      }], { session });
      const completed = await addPurchasedCredits(session, purchase, `credit:${purchase.purchaseId}`);
      purchase.walletTransactionId = referenceId;
      await purchase.save({ session });
      await Notification.create([{ userId: req.session.sub, message: `${purchase.credits.toLocaleString('en-IN')} AI credits were added to your account.` }], { session });
      return { purchase: completed.purchase, balance: completed.credits.balance, duplicate: false };
    });
    return res.status(result.duplicate ? 200 : 201).json({ purchase: creditPurchaseView(result.purchase), balance: result.balance, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This credit payment is already being processed.' });
    throw error;
  }
});

app.post('/api/credits/razorpay/create', requireSession, requireDatabase, requirePurchaseAge, requireExclusiveCreditAccess, async (req, res) => {
  let purchase = await CreditPurchase.findOne({ purchaseId: req.body?.purchaseId, userId: req.session.sub });
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  if (purchase.status === 'completed') return res.json({ purchase: creditPurchaseView(purchase) });
  if (purchase.paymentMethod !== 'Razorpay') return res.status(409).json({ message: 'This purchase is configured for Wallet payment.' });
  if (!['pending', 'processing'].includes(purchase.status)) return res.status(409).json({ message: 'This credit purchase is no longer payable.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for credit purchases.' });
  if (purchase.razorpayOrderId) return res.json({ purchase: creditPurchaseView(purchase), orderId: purchase.razorpayOrderId, keyId: razorpayKeyId, amountPaise: purchase.totalAmountPaise });
  const orderCreationStartedAt = new Date();
  const claimed = await CreditPurchase.findOneAndUpdate({
    _id: purchase._id,
    status: { $in: ['pending', 'processing'] },
    razorpayOrderId: { $exists: false },
    $or: [
      { razorpayOrderCreationStartedAt: { $exists: false } },
      { razorpayOrderCreationStartedAt: { $lt: new Date(Date.now() - 60 * 1000) } },
    ],
  }, { $set: { razorpayOrderCreationStartedAt: orderCreationStartedAt } }, { new: true });
  if (!claimed) {
    const latest = await CreditPurchase.findById(purchase._id).lean();
    if (latest?.razorpayOrderId) return res.json({ purchase: creditPurchaseView(latest), orderId: latest.razorpayOrderId, keyId: razorpayKeyId, amountPaise: latest.totalAmountPaise });
    return res.status(409).json({ message: 'This credit payment is already being prepared. Please retry shortly.' });
  }
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: purchase.totalAmountPaise, currency: 'INR', receipt: purchase.purchaseId }),
    });
    const order = await response.json();
    if (!response.ok || typeof order.id !== 'string') {
      await CreditPurchase.updateOne({ _id: purchase._id, razorpayOrderCreationStartedAt: orderCreationStartedAt }, { $set: { status: 'failed' }, $unset: { razorpayOrderCreationStartedAt: 1 } });
      return res.status(502).json({ message: 'Razorpay could not create the credit payment.' });
    }
    const saved = await CreditPurchase.findOneAndUpdate(
      { _id: purchase._id, status: { $in: ['pending', 'processing'] }, razorpayOrderCreationStartedAt: orderCreationStartedAt },
      { $set: { razorpayOrderId: order.id, status: 'processing' }, $unset: { razorpayOrderCreationStartedAt: 1 } },
      { new: true },
    );
    if (!saved) return res.status(409).json({ message: 'The credit payment order could not be attached safely. Please contact support before retrying payment.' });
    return res.json({ purchase: creditPurchaseView(saved), orderId: order.id, keyId: razorpayKeyId, amountPaise: saved.totalAmountPaise });
  } catch {
    return res.status(503).json({ message: 'Online credit payment is temporarily unavailable.' });
  }
});

app.post('/api/credits/razorpay/verify', requireSession, requireDatabase, requirePurchaseAge, requireExclusiveCreditAccess, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  const purchaseId = req.body?.purchaseId;
  if (![orderId, paymentId, signature, purchaseId].every((value) => typeof value === 'string' && value)) return res.status(400).json({ message: 'Credit payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for credit purchases.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) return res.status(401).json({ message: 'Payment verification failed. Please contact support if money was deducted.' });
  const purchase = await CreditPurchase.findOne({ purchaseId, userId: req.session.sub, razorpayOrderId: orderId }).lean();
  if (!purchase) return res.status(404).json({ message: 'Credit purchase was not found.' });
  if (purchase.status === 'completed') {
    if (purchase.razorpayPaymentId !== paymentId) return res.status(409).json({ message: 'This credit purchase was completed with another payment.' });
    return res.json({ purchase: creditPurchaseView(purchase), balance: purchase.newBalance, duplicate: true });
  }
  if (!['pending', 'processing'].includes(purchase.status)) return res.status(409).json({ message: 'This credit purchase is no longer payable.' });
  let payment;
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    payment = await response.json();
    if (!response.ok || payment.id !== paymentId || payment.amount !== purchase.totalAmountPaise || payment.order_id !== orderId || payment.currency !== 'INR' || payment.status !== 'captured') return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Payment verification is temporarily unavailable.' });
  }
  try {
    const result = await finalizeRazorpayCreditPurchase({ userId: req.session.sub, purchaseId, orderId, payment });
    return res.json({ purchase: creditPurchaseView(result.purchase), balance: result.balance, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This credit payment is already being processed.' });
    throw error;
  }
});

app.get('/api/credits/purchases/pending', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const purchases = await CreditPurchase.find({
    userId: req.session.sub,
    paymentMethod: 'Razorpay',
    status: { $in: ['pending', 'processing'] },
    razorpayOrderId: { $type: 'string' },
  }).sort({ createdAt: -1 }).limit(10).lean();
  return res.json({ purchases: purchases.map(creditPurchaseView) });
});

app.post('/api/credits/razorpay/reconcile/:purchaseId', requireSession, requireDatabase, requireExclusiveCreditAccess, async (req, res) => {
  const purchase = await CreditPurchase.findOne({
    purchaseId: req.params.purchaseId,
    userId: req.session.sub,
    paymentMethod: 'Razorpay',
  }).lean();
  if (!purchase) return res.status(404).json({ message: 'A credit purchase was not found.' });
  if (purchase.status === 'completed') {
    return res.json({ purchase: creditPurchaseView(purchase), balance: purchase.newBalance, duplicate: true, pending: false });
  }
  if (!['pending', 'processing'].includes(purchase.status) || !purchase.razorpayOrderId) return res.status(409).json({ message: 'This credit purchase cannot be reconciled.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay verification is not configured.' });
  try {
    const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(purchase.razorpayOrderId)}/payments`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.items)) return res.status(503).json({ message: 'Razorpay payment status is temporarily unavailable.' });
    const payment = result.items.find((item) => item.order_id === purchase.razorpayOrderId
      && item.amount === purchase.totalAmountPaise && item.currency === 'INR' && item.status === 'captured');
    if (!payment) return res.json({ pending: true, purchase: creditPurchaseView(purchase) });
    const completed = await finalizeRazorpayCreditPurchase({
      userId: req.session.sub,
      purchaseId: purchase.purchaseId,
      orderId: purchase.razorpayOrderId,
      payment,
    });
    return res.json({ pending: false, purchase: creditPurchaseView(completed.purchase), balance: completed.balance, duplicate: completed.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment has already been applied to a credit purchase.' });
    return res.status(503).json({ message: 'Razorpay payment status is temporarily unavailable.' });
  }
});

app.get('/api/ai-credits', requireSession, requireDatabase, async (req, res) => {
  const subscription = await currentSubscription(req.session.sub);
  const [credits, transactions, purchases] = await Promise.all([
    AICredits.findOne({ userId: req.session.sub }).lean(),
    AICreditTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean(),
    CreditPurchase.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  const billSummary = await getAiBillSummary(req.session.sub);
  return res.json({
    plan: subscription?.plan || 'Starter',
    balance: credits?.balance || 0,
    transactions,
    purchases: purchases.map(creditPurchaseView),
    billState: {
      plan: billSummary.plan,
      includedAllowance: billSummary.includedAllowance,
      includedRemaining: billSummary.includedRemaining,
      purchasedBills: billSummary.purchasedBills,
      purchasedRemaining: billSummary.purchasedRemaining,
      totalAvailable: billSummary.totalAvailable,
      usedBills: billSummary.usedBills,
      nextAllowanceReset: billSummary.nextAllowanceReset,
    },
    pricePerCredit: money(aiCreditPricePaise),
    maxPurchase: aiCreditMaxPurchase,
    costs: aiCreditCosts,
    addBillsVisible: true,
  });
});

app.get('/api/ai-bills', requireSession, requireDatabase, async (req, res) => {
  const summary = await getAiBillSummary(req.session.sub);
  const [recent, history, credits] = await Promise.all([
    AIBillPurchase.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(50).lean(),
    AIBillTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean(),
    AICredits.findOne({ userId: req.session.sub }).select('balance').lean(),
  ]);
  return res.json({
    plan: summary.plan,
    includedAllowance: summary.includedAllowance,
    includedRemaining: summary.includedRemaining,
    purchasedBills: summary.purchasedBills,
    purchasedRemaining: summary.purchasedRemaining,
    totalAvailable: summary.totalAvailable,
    usedBills: summary.usedBills,
    nextAllowanceReset: summary.nextAllowanceReset,
    creditBalance: credits?.balance || 0,
    history,
    purchases: recent.map((purchase) => ({
      id: purchase.purchaseId,
      quantity: purchase.quantity,
      totalAmount: money(purchase.totalAmountPaise),
      paymentMethod: purchase.paymentMethod,
      status: purchase.status,
      createdAt: purchase.createdAt,
    })),
  });
});

app.post('/api/bills/purchase', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const quantity = Number(req.body?.quantity);
  const paymentMethod = req.body?.paymentMethod;
  const idempotencyKey = req.body?.idempotencyKey;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ message: 'Enter a whole number of bills between 1 and 20.' });
  if (!['Wallet', 'Razorpay'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Online Payment.' });
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase reference is required.' });
  if (paymentMethod === 'Razorpay' && (!razorpayKeyId || !razorpayKeySecret)) return res.status(503).json({ message: 'Razorpay is not configured for AI bill purchases.' });
  const baseAmountPaise = quantity * 20000;
  let purchase = await AIBillPurchase.findOne({ userId: req.session.sub, idempotencyKey });
  if (purchase) {
    if (purchase.quantity !== quantity || purchase.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'This purchase reference is already used for a different bill purchase.' });
    if (purchase.status === 'failed' || purchase.status === 'cancelled') return res.status(409).json({ message: 'This bill purchase cannot be resumed. Start a new purchase.' });
    if (purchase.status === 'completed') return res.json({ purchase: billPurchaseView(purchase), duplicate: true });
  } else {
    const subscriptionDiscount = await subscriptionDiscountForAmount(req.session.sub, baseAmountPaise);
    const totalAmountPaise = Math.max(0, baseAmountPaise - subscriptionDiscount.amountPaise);
    try {
      [purchase] = await AIBillPurchase.create([{
        purchaseId: crypto.randomUUID(),
        userId: req.session.sub,
        quantity,
        baseAmountPaise,
        totalAmountPaise,
        subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
        subscriptionDiscountPlan: subscriptionDiscount.plan,
        subscriptionDiscountPercent: subscriptionDiscount.percentage,
        paymentMethod,
        paymentReference: `${paymentMethod === 'Wallet' ? 'bill-wallet' : 'bill-razorpay'}:${idempotencyKey}`,
        status: 'pending',
        idempotencyKey,
      }]);
    } catch (error) {
      if (error.code !== 11000) throw error;
      purchase = await AIBillPurchase.findOne({ userId: req.session.sub, idempotencyKey });
      if (!purchase || purchase.quantity !== quantity || purchase.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'This purchase reference is already in use.' });
    }
  }
  if (paymentMethod === 'Wallet') {
    const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise pinHash').lean();
    if (!wallet?.pinHash) return res.status(409).json({ message: 'Set up your Wallet PIN before paying from your wallet.' });
    return res.status(201).json({
      purchase: billPurchaseView(purchase),
      walletBalance: money(walletAvailableBalancePaise(wallet)),
      hasWalletPin: true,
    });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for AI bill purchases.' });
  if (purchase.razorpayOrderId) {
    return res.json({ purchase: billPurchaseView(purchase), orderId: purchase.razorpayOrderId, keyId: razorpayKeyId, amountPaise: purchase.totalAmountPaise });
  }
  const orderCreationStartedAt = new Date();
  const orderCreationClaim = await AIBillPurchase.findOneAndUpdate({
    _id: purchase._id,
    status: 'pending',
    razorpayOrderId: { $exists: false },
    $or: [
      { razorpayOrderCreationStartedAt: { $exists: false } },
      { razorpayOrderCreationStartedAt: { $lt: new Date(Date.now() - 60 * 1000) } },
    ],
  }, { $set: { razorpayOrderCreationStartedAt: orderCreationStartedAt } }, { new: true });
  if (!orderCreationClaim) {
    const latest = await AIBillPurchase.findById(purchase._id).lean();
    if (latest?.razorpayOrderId) {
      return res.json({ purchase: billPurchaseView(latest), orderId: latest.razorpayOrderId, keyId: razorpayKeyId, amountPaise: latest.totalAmountPaise });
    }
    return res.status(409).json({ message: 'This online AI bill payment is already being prepared. Please retry shortly.' });
  }
  try {
    const providerResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: purchase.totalAmountPaise, currency: 'INR', receipt: `ai-bill-${purchase.purchaseId}` }),
    });
    const order = await providerResponse.json();
    if (!providerResponse.ok || typeof order.id !== 'string') {
      await AIBillPurchase.updateOne({ _id: purchase._id, razorpayOrderCreationStartedAt: orderCreationStartedAt }, { $set: { status: 'failed' }, $unset: { razorpayOrderCreationStartedAt: 1 } });
      return res.status(502).json({ message: 'Razorpay could not create the AI bill purchase order.' });
    }
    const saved = await AIBillPurchase.findOneAndUpdate(
      { _id: purchase._id, status: 'pending', razorpayOrderCreationStartedAt: orderCreationStartedAt },
      { $set: { razorpayOrderId: order.id }, $unset: { razorpayOrderCreationStartedAt: 1 } },
      { new: true },
    );
    if (!saved) return res.status(409).json({ message: 'The AI bill payment order could not be attached safely. Please contact support before retrying payment.' });
    return res.json({ purchase: billPurchaseView(saved), orderId: order.id, keyId: razorpayKeyId, amountPaise: saved.totalAmountPaise });
  } catch {
    return res.status(503).json({ message: 'AI bill payment is temporarily unavailable.' });
  }
});

const billPurchaseView = (purchase) => ({
  purchaseId: purchase.purchaseId,
  quantity: purchase.quantity,
  baseAmount: money(purchase.baseAmountPaise || purchase.totalAmountPaise),
  subscriptionDiscountAmount: money(purchase.subscriptionDiscountAmountPaise || 0),
  subscriptionDiscountPlan: purchase.subscriptionDiscountPlan || 'Starter',
  subscriptionDiscountPercent: purchase.subscriptionDiscountPercent || 0,
  totalAmount: money(purchase.totalAmountPaise),
  paymentMethod: purchase.paymentMethod,
  status: purchase.status,
  creditsDeducted: purchase.creditsDeducted || 0,
  createdAt: purchase.createdAt,
});

app.get('/api/bills/purchase/:purchaseId', requireSession, requireDatabase, async (req, res) => {
  const purchase = await AIBillPurchase.findOne({ purchaseId: req.params.purchaseId, userId: req.session.sub }).lean();
  if (!purchase) return res.status(404).json({ message: 'The AI bill purchase could not be found.' });
  const wallet = purchase.paymentMethod === 'Wallet'
    ? await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise pinHash').lean()
    : null;
  return res.json({
    purchase: billPurchaseView(purchase),
    walletBalance: wallet ? money(walletAvailableBalancePaise(wallet)) : null,
    hasWalletPin: Boolean(wallet?.pinHash),
  });
});

const grantPurchasedBills = async (session, purchase) => {
  const subscription = await currentSubscription(purchase.userId, session);
  const billState = await ensureAiBillAllowance(purchase.userId, session, subscription);
  const updatedState = await AICredits.findOneAndUpdate(
    { userId: purchase.userId },
    { $inc: { purchasedBills: purchase.quantity } },
    { new: true, session },
  );
  if (!updatedState) throw new Error('Purchased AI bills could not be added to the account.');
  const creditCost = purchase.quantity * 100;
  let creditsDeducted = 0;
  if (creditCost > 0) {
    const credits = await ensureAiCreditBuckets(purchase.userId, session);
    if (credits && credits.balance >= creditCost) {
      const previousBalance = credits.balance;
      const includedSpend = Math.min(creditCost, credits.includedCreditsRemaining);
      const purchasedSpend = creditCost - includedSpend;
      if (purchasedSpend > credits.purchasedCreditsRemaining) {
        throw new Error('The AI credit balance could not be allocated to its recorded sources.');
      }
      credits.balance -= creditCost;
      credits.includedCreditsRemaining -= includedSpend;
      credits.purchasedCreditsRemaining -= purchasedSpend;
      credits.usedCredits += creditCost;
      await credits.save({ session });
      creditsDeducted = creditCost;
      await AICreditTransaction.create([{
        userId: purchase.userId,
        type: 'used',
        amount: creditCost,
        action: 'purchased_bill_credit_discount',
        reference: `bill-purchase-credits:${purchase.purchaseId}`,
        purchaseId: purchase.purchaseId,
        paymentMethod: purchase.paymentMethod,
        amountPaise: 0,
        previousBalance,
        balanceAfter: credits.balance,
      }], { session });
    }
  }
  await AIBillTransaction.create([{
    userId: purchase.userId,
    type: 'purchase',
    quantity: purchase.quantity,
    reference: `bill-purchase:${purchase.purchaseId}`,
    source: purchase.paymentMethod,
    includedRemaining: Math.max(0, billState.includedBills - billState.usedBills),
    purchasedRemaining: updatedState.purchasedBills,
    purchaseId: purchase.purchaseId,
  }], { session });
  purchase.creditsDeducted = creditsDeducted;
  purchase.status = 'completed';
  await createInvoiceForStandalonePurchase(session, {
    userId: purchase.userId,
    orderId: `AI-BILL-${purchase.purchaseId}`,
    paymentId: purchase.paymentReference,
    paymentMethod: purchase.paymentMethod,
    itemName: `${purchase.quantity} AI bill${purchase.quantity === 1 ? '' : 's'}`,
    amountPaise: purchase.totalAmountPaise,
    baseAmountPaise: purchase.baseAmountPaise || purchase.totalAmountPaise,
    subscriptionDiscountAmountPaise: purchase.subscriptionDiscountAmountPaise || 0,
    subscriptionDiscountPlan: purchase.subscriptionDiscountPlan || 'Starter',
    subscriptionDiscountPercent: purchase.subscriptionDiscountPercent || 0,
  });
  return purchase;
};

const finalizeRazorpayBillPurchase = async ({ userId, purchaseId, orderId, paymentId, amountPaise }) => withMongoTransaction(async (session) => {
  const purchase = await AIBillPurchase.findOne({ purchaseId, userId }).session(session);
  if (!purchase) throw Object.assign(new Error('The AI bill purchase could not be found.'), { status: 404 });
  if (purchase.status === 'completed') {
    if (purchase.razorpayPaymentId !== paymentId) throw Object.assign(new Error('This purchase was completed with another payment.'), { status: 409 });
    return { purchase, duplicate: true };
  }
  if (purchase.status !== 'pending' || purchase.paymentMethod !== 'Razorpay'
    || purchase.razorpayOrderId !== orderId || purchase.totalAmountPaise !== amountPaise) {
    throw Object.assign(new Error('This AI bill purchase is no longer payable.'), { status: 409 });
  }
  purchase.razorpayPaymentId = paymentId;
  purchase.paymentReference = `bill-razorpay:${paymentId}`;
  await grantPurchasedBills(session, purchase);
  await purchase.save({ session });
  return { purchase, duplicate: false };
});

app.get('/api/bills/purchases/pending', requireSession, requireDatabase, async (req, res) => {
  const purchases = await AIBillPurchase.find({
    userId: req.session.sub,
    paymentMethod: 'Razorpay',
    status: 'pending',
    razorpayOrderId: { $type: 'string' },
  }).sort({ createdAt: -1 }).limit(10).lean();
  return res.json({ purchases: purchases.map((purchase) => billPurchaseView(purchase)) });
});

app.post('/api/bills/razorpay/reconcile/:purchaseId', requireSession, requireDatabase, async (req, res) => {
  const purchase = await AIBillPurchase.findOne({
    purchaseId: req.params.purchaseId,
    userId: req.session.sub,
    paymentMethod: 'Razorpay',
  }).lean();
  if (!purchase) return res.status(404).json({ message: 'An online AI bill purchase was not found.' });
  if (purchase.status === 'completed') {
    return res.json({
      pending: false,
      purchase: billPurchaseView(purchase),
      bills: await getAiBillSummary(req.session.sub),
      duplicate: true,
    });
  }
  if (purchase.status !== 'pending' || !purchase.razorpayOrderId) return res.status(409).json({ message: 'This online AI bill purchase cannot be reconciled.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay verification is not configured.' });
  try {
    const response = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(purchase.razorpayOrderId)}/payments`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.items)) return res.status(503).json({ message: 'Razorpay payment status is temporarily unavailable.' });
    const payment = result.items.find((item) => item.order_id === purchase.razorpayOrderId
      && item.amount === purchase.totalAmountPaise && item.currency === 'INR' && item.status === 'captured');
    if (!payment) return res.json({ pending: true, purchase: billPurchaseView(purchase) });
    const completed = await finalizeRazorpayBillPurchase({
      userId: req.session.sub,
      purchaseId: purchase.purchaseId,
      orderId: purchase.razorpayOrderId,
      paymentId: payment.id,
      amountPaise: purchase.totalAmountPaise,
    });
    return res.json({
      pending: false,
      purchase: billPurchaseView(completed.purchase),
      bills: await getAiBillSummary(req.session.sub),
      duplicate: completed.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment has already been applied to an AI bill purchase.' });
    return res.status(503).json({ message: 'Razorpay payment status is temporarily unavailable.' });
  }
});

app.post('/api/bills/wallet/confirm', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const { purchaseId, pin } = req.body || {};
  if (typeof purchaseId !== 'string' || !validatePin(pin)) return res.status(400).json({ message: 'AI bill purchase and 4-digit Wallet PIN are required.' });
  const walletSnapshot = await Wallet.findOne({ userId: req.session.sub }).select('pinHash failedPinAttempts lockedUntil').lean();
  if (!walletSnapshot?.pinHash) return res.status(409).json({ message: 'Set up your Wallet PIN before paying from your wallet.' });
  if (walletSnapshot.lockedUntil && walletSnapshot.lockedUntil > new Date()) return res.status(429).json({ message: 'Wallet PIN is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, walletSnapshot.pinHash)) {
    const failedPinAttempts = (walletSnapshot.failedPinAttempts || 0) + 1;
    await Wallet.updateOne(
      { userId: req.session.sub, pinHash: walletSnapshot.pinHash, failedPinAttempts: walletSnapshot.failedPinAttempts || 0 },
      { $set: { failedPinAttempts: failedPinAttempts >= 5 ? 0 : failedPinAttempts, lockedUntil: failedPinAttempts >= 5 ? new Date(Date.now() + 10 * 60 * 1000) : walletSnapshot.lockedUntil || null } },
    );
    return res.status(401).json({ message: 'Incorrect PIN. Payment was not completed.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const purchase = await AIBillPurchase.findOne({ purchaseId, userId: req.session.sub }).session(session);
      if (!purchase) throw Object.assign(new Error('AI bill purchase was not found.'), { status: 404 });
      if (purchase.status === 'completed') return { purchase, duplicate: true };
      if (purchase.paymentMethod !== 'Wallet' || purchase.status !== 'pending') throw Object.assign(new Error('This AI bill purchase is no longer payable.'), { status: 409 });
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet?.pinHash) throw Object.assign(new Error('Set up your Wallet PIN before paying from your wallet.'), { status: 409 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet PIN is temporarily locked. Please try again later.'), { status: 429 });
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect PIN. Payment was not completed.'), { status: 401 });
      await assertWalletSpendAvailable(req.session.sub, wallet, purchase.totalAmountPaise, session);
      if (wallet.balancePaise < purchase.totalAmountPaise) throw Object.assign(new Error(`Insufficient wallet balance. Required: ${money(purchase.totalAmountPaise)}.`), { status: 402 });
      const balanceBeforePaise = wallet.balancePaise;
      wallet.balancePaise -= purchase.totalAmountPaise;
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = null;
      await wallet.save({ session });
      const referenceId = `bill-wallet:${purchase.purchaseId}`;
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -purchase.totalAmountPaise,
        balanceBeforePaise,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `AI bill purchase (${purchase.quantity} bills)`,
        status: 'Successful',
      }], { session });
      purchase.walletTransactionId = referenceId;
      await grantPurchasedBills(session, purchase);
      await purchase.save({ session });
      return { purchase, duplicate: false };
    });
    return res.status(result.duplicate ? 200 : 201).json({
      purchase: billPurchaseView(result.purchase),
      bills: await getAiBillSummary(req.session.sub),
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This bill purchase is already being processed.' });
    throw error;
  }
});

app.post('/api/bills/razorpay/verify', requireSession, requireDatabase, async (req, res) => {
  const body = req.body || {};
  const paymentId = body.razorpay_payment_id;
  const orderId = body.razorpay_order_id;
  const signature = body.razorpay_signature;
  const purchaseId = body.purchaseId;
  if (![paymentId, orderId, signature, purchaseId].every((value) => typeof value === 'string' && value)) return res.status(400).json({ message: 'A valid AI bill payment verification is required.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for AI bill purchases.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const signatureBuffer = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) return res.status(401).json({ message: 'AI bill payment verification failed.' });
  const purchase = await AIBillPurchase.findOne({ purchaseId, userId: req.session.sub, paymentMethod: 'Razorpay', razorpayOrderId: orderId });
  if (!purchase) return res.status(404).json({ message: 'The AI bill purchase could not be found.' });
  if (purchase.status === 'completed') {
    if (purchase.razorpayPaymentId !== paymentId) return res.status(409).json({ message: 'This purchase was completed with another payment.' });
    return res.json({ purchase: billPurchaseView(purchase), bills: await getAiBillSummary(req.session.sub), duplicate: true });
  }
  let payment;
  try {
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.amount !== purchase.totalAmountPaise || payment.order_id !== orderId || payment.currency !== 'INR' || payment.status !== 'captured') return res.status(409).json({ message: 'AI bill payment amount or capture status could not be verified.' });
  } catch {
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
  try {
    const result = await finalizeRazorpayBillPurchase({
      userId: req.session.sub,
      purchaseId,
      orderId,
      paymentId,
      amountPaise: payment.amount,
    });
    return res.json({
      purchase: billPurchaseView(result.purchase),
      bills: await getAiBillSummary(req.session.sub),
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment has already been applied to an AI bill purchase.' });
    throw error;
  }
});

app.get('/api/admin/ai-bill-purchases', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const [purchases, transactions] = await Promise.all([
    AIBillPurchase.find().sort({ createdAt: -1 }).limit(500).lean(),
    AIBillTransaction.find().sort({ createdAt: -1 }).limit(1000).lean(),
  ]);
  const userIds = [...new Set([...purchases.map((purchase) => purchase.userId), ...transactions.map((transaction) => transaction.userId)])];
  const users = await User.find({ googleId: { $in: userIds } }).select('googleId name email').lean();
  const usersById = new Map(users.map((user) => [user.googleId, { id: user.googleId, name: user.name, email: user.email }]));
  return res.json({
    purchases: purchases.map((purchase) => ({ ...billPurchaseView(purchase), user: usersById.get(purchase.userId) || { id: purchase.userId } })),
    transactions: transactions.map((transaction) => ({ ...transaction, user: usersById.get(transaction.userId) || { id: transaction.userId } })),
  });
});

app.get('/api/admin/credit-purchases', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const purchases = await CreditPurchase.find().sort({ createdAt: -1 }).limit(500).lean();
  const users = await User.find({ googleId: { $in: purchases.map((purchase) => purchase.userId) } }).select('googleId name email').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({ purchases: purchases.map((purchase) => ({ ...creditPurchaseView(purchase), user: usersById.get(purchase.userId) || { id: purchase.userId } })) });
});

const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
let geminiClient;
const getGeminiClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('The AI Project Builder is not configured yet. Add GEMINI_API_KEY to the server environment.'), { status: 503, code: 'GEMINI_NOT_CONFIGURED' });
  }
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
};

const aiIdempotencyKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const requestDigest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const forbiddenProjectCode = (value) => /```|#include\b|void\s+setup\s*\(|void\s+loop\s*\(|function\s+setup\s*\(/i.test(value);

app.get('/api/ai/entitlements', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  return res.json(aiAccessResponse(access, await getAiBillSummary(req.session.sub)));
});

app.get('/api/ai/trial/status', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  return res.json({ trial: { ...access.trial, eligible: access.trialEligible }, subscription: access.subscription ? {
    plan: access.subscription.plan,
    expiryDate: access.subscription.expiryDate,
  } : null, effectivePlan: access.plan, accessType: access.accessType });
});

app.post('/api/ai/trial/activate', requireSession, requireDatabase, async (req, res) => {
  const plan = req.body?.plan;
  if (!['Premium', 'Exclusive'].includes(plan) || req.body?.termsAccepted !== true) {
    return res.status(400).json({ message: 'Select Pro or Exclusive and accept the trial terms to continue.' });
  }
  const subscription = await currentSubscription(req.session.sub);
  if (subscription) return res.status(409).json({ code: 'PAID_PLAN_ACTIVE', message: 'An active paid subscription cannot be combined with a free trial.' });
  const previousTrial = await AITrial.findOne({ userId: req.session.sub }).lean();
  if (previousTrial) return res.status(409).json({ code: 'TRIAL_ALREADY_USED', message: 'Your free trial has already been used.' });
  const activatedAt = new Date();
  try {
    const [trial] = await AITrial.create([{
      userId: req.session.sub,
      plan,
      status: 'active',
      activatedAt,
      expiresAt: new Date(activatedAt.getTime() + 4 * 24 * 60 * 60 * 1000),
      buildLimit: 2,
      successfulBuilds: 0,
    }]);
    return res.status(201).json({
      trial: { ...aiTrialView(trial.toObject(), activatedAt), eligible: false },
      ...aiAccessResponse(await getAiAccess(req.session.sub)),
      message: 'Your four-day trial is active. Trial activation does not start paid billing or grant cashback.',
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ code: 'TRIAL_ALREADY_USED', message: 'Your free trial has already been used.' });
    throw error;
  }
});

app.post('/api/ai/trial/expiration-warning/claim', requireSession, requireDatabase, async (req, res) => {
  const now = new Date();
  await AITrial.updateMany(
    { userId: req.session.sub, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
  const warningTrial = await AITrial.findOneAndUpdate(
    {
      userId: req.session.sub,
      status: 'active',
      expiresAt: { $gt: now, $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      expirationWarningShownAt: { $exists: false },
    },
    { $set: { expirationWarningShownAt: now } },
    { new: true },
  ).select('plan expiresAt expirationWarningShownAt').lean();
  return res.json({
    warning: warningTrial ? {
      plan: warningTrial.plan,
      expiresAt: warningTrial.expiresAt,
      shownAt: warningTrial.expirationWarningShownAt,
    } : null,
  });
});

app.post('/api/ai/project-builder', requireSession, requireDatabase, async (req, res) => {
  const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : '';
  const budgetValue = req.body?.budget;
  const budget = budgetValue == null || budgetValue === '' ? null : Number(budgetValue);
  const idempotencyKey = req.body?.idempotencyKey;
  if (!idea || idea.length > 2000) return res.status(400).json({ message: 'Enter a project idea between 1 and 2,000 characters.' });
  if (budget !== null && (!Number.isFinite(budget) || budget <= 0 || budget > 1000000)) return res.status(400).json({ message: 'Enter a valid project budget up to ₹10,00,000.' });
  if (!aiIdempotencyKey(idempotencyKey)) return res.status(400).json({ message: 'A valid request key is required. Please try again.' });
  let client;
  try {
    client = getGeminiClient();
  } catch (error) {
    return res.status(error.status || 503).json({ code: error.code || 'AI_UNAVAILABLE', message: error.message });
  }
  const userId = req.session.sub;
  const normalizedRequest = { idea, budget };
  const digest = requestDigest(normalizedRequest);
  const previous = await AIProjectBuild.findOne({ userId, idempotencyKey }).lean();
  if (previous) {
    if (previous.requestHash !== digest) return res.status(409).json({ message: 'This request key was already used for a different project.' });
    if (previous.status === 'succeeded') return res.json(previous.result);
    if (previous.status === 'generating') return res.status(409).json({ message: 'This project is already being generated.' });
    return res.status(409).json({ message: 'This request already failed. Start a new project request to retry.' });
  }

  const now = new Date();
  const recentMinute = await AIProjectBuild.countDocuments({ userId, createdAt: { $gte: new Date(now.getTime() - 60 * 1000) } });
  const recentDay = await AIProjectBuild.countDocuments({ userId, createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } });
  if (recentMinute >= 3 || recentDay >= 20) return res.status(429).json({ message: 'Project generation is temporarily rate-limited. Please wait before trying again.' });
  const billState = await getAiBillSummary(userId);
  if (billState.totalAvailable <= 0) return res.status(403).json({ code: 'AI_BILL_LIMIT', message: 'You have no AI bills remaining. Add AI bills to keep generating projects.' });
  const access = await getAiAccess(userId);
  if (access.trialMode && access.remainingBuilds === 0) {
    return res.status(403).json({ code: 'AI_BUILD_LIMIT', message: `You have used the ${access.buildLimit} project builds available on ${displayPlanName(access.plan)}. Upgrade to continue building.` });
  }

  let build;
  let quotaReserved = false;
  try {
    build = await AIProjectBuild.create({
      userId,
      idempotencyKey,
      requestHash: digest,
      quotaKey: access.quotaKey,
      plan: access.plan,
      status: 'generating',
    });
    await withMongoTransaction(async (session) => {
      await AIProjectQuota.updateOne(
        { userId, quotaKey: access.quotaKey },
        { $setOnInsert: { userId, quotaKey: access.quotaKey, buildLimit: access.buildLimit, successfulBuilds: 0, pendingBuilds: 0 } },
        { upsert: true, session },
      );
      const quotaFilter = { userId, quotaKey: access.quotaKey };
      if (access.trialMode) quotaFilter.$expr = { $lt: [{ $add: ['$successfulBuilds', '$pendingBuilds'] }, access.buildLimit] };
      const quota = await AIProjectQuota.findOneAndUpdate(quotaFilter, { $inc: { pendingBuilds: 1 } }, { new: true, session });
      if (!quota) throw Object.assign(new Error(`You have used the ${access.buildLimit} project builds available on ${displayPlanName(access.plan)}. Upgrade to continue building.`), { status: 403, code: 'AI_BUILD_LIMIT' });
    });
    quotaReserved = true;

    const inventory = await InventoryItem.find().sort({ category: 1, name: 1 }).limit(250).select('productId name category description technicalSpecs pricePaise stock status images').lean();
    const catalogForModel = inventory.map((item) => ({
      productId: item.productId,
      name: item.name,
      category: item.category,
      description: String(item.description || '').slice(0, 400),
      specifications: item.technicalSpecs || {},
      price: money(item.pricePaise),
      stock: item.stock,
      stockStatus: item.status,
    }));
    const schema = {
      type: Type.OBJECT,
      properties: {
        projectTitle: { type: Type.STRING },
        description: { type: Type.STRING },
        objective: { type: Type.STRING },
        expectedBehavior: { type: Type.STRING },
        components: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              quantity: { type: Type.INTEGER },
              specifications: { type: Type.STRING },
              wiringHint: { type: Type.STRING },
              catalogProductId: { type: Type.STRING, nullable: true },
            },
            required: ['name', 'quantity', 'specifications', 'wiringHint', 'catalogProductId'],
          },
        },
        wiringPlan: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['projectTitle', 'description', 'objective', 'expectedBehavior', 'components', 'wiringPlan'],
    };
    const response = await client.models.generateContent({
      model: geminiModel,
      contents: [
        'Design a practical Arduino/electronics project only. Return no source code, code snippets, difficulty or stability ratings, interaction scores, payment advice, or invented catalog products. Use only the supplied catalog product IDs when a compatible item is an exact match; otherwise use null and mark that component as unavailable through its missing match in the returned result. Do not claim stock that the catalog does not report. Keep wiring advice cautious when specifications are missing. Respect the user budget if supplied and clearly state assumptions.',
        `User project request: ${idea}`,
        `Budget ceiling INR: ${budget == null ? 'not specified' : budget}`,
        `Current MongoDB catalog: ${JSON.stringify(catalogForModel)}`,
      ].join('\n\n'),
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 4096,
        temperature: 0.35,
      },
    });
    const rawText = response.text?.trim();
    if (!rawText) throw Object.assign(new Error('Gemini returned no project content.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    let generated;
    try { generated = JSON.parse(rawText); } catch {
      throw Object.assign(new Error('The project response could not be validated. Please try again.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    }
    const textField = (value, maxLength) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !forbiddenProjectCode(value);
    if (!textField(generated.projectTitle, 120) || !textField(generated.description, 1200) || !textField(generated.objective, 600) || !textField(generated.expectedBehavior, 800)
      || !Array.isArray(generated.components) || generated.components.length < 1 || generated.components.length > 30
      || !Array.isArray(generated.wiringPlan) || generated.wiringPlan.length < 1 || generated.wiringPlan.length > 16
      || generated.wiringPlan.some((step) => !textField(step, 400))) {
      throw Object.assign(new Error('The project response did not meet the required format. Please try again.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
    }
    const inventoryById = new Map(inventory.map((item) => [item.productId, item]));
    const components = generated.components.map((component) => {
      if (!textField(component.name, 120) || !Number.isInteger(component.quantity) || component.quantity < 1 || component.quantity > 99
        || typeof component.specifications !== 'string' || component.specifications.length > 500 || forbiddenProjectCode(component.specifications)
        || typeof component.wiringHint !== 'string' || component.wiringHint.length > 500 || forbiddenProjectCode(component.wiringHint)) {
        throw Object.assign(new Error('The project response included an invalid component.'), { status: 502, code: 'AI_INVALID_OUTPUT' });
      }
      const product = typeof component.catalogProductId === 'string' ? inventoryById.get(component.catalogProductId) : null;
      const available = Boolean(product && product.status !== 'Out of Stock' && product.stock >= component.quantity);
      const unitPrice = product ? money(product.pricePaise) : null;
      return {
        name: component.name.trim(),
        quantity: component.quantity,
        specifications: component.specifications.trim(),
        wiringHint: component.wiringHint.trim(),
        available,
        availability: !product ? 'Not available in the Innovation Labs catalog' : available ? product.status : product.status === 'Out of Stock' ? 'Out of stock' : `Only ${product.stock} in stock`,
        product: product ? {
          id: product.productId,
          name: product.name,
          category: product.category,
          description: product.description || '',
          price: unitPrice,
          lineTotal: unitPrice * component.quantity,
          stock: product.stock,
          status: product.status,
          images: (product.images || []).slice(0, 4),
          inventoryProduct: true,
          productUrl: `/products/${encodeURIComponent(product.productId)}`,
        } : null,
      };
    });
    const subtotal = components.reduce((sum, component) => sum + (component.product?.lineTotal || 0), 0);
    const result = {
      projectId: crypto.randomUUID(),
      title: generated.projectTitle.trim(),
      description: generated.description.trim(),
      objective: generated.objective.trim(),
      expectedBehavior: generated.expectedBehavior.trim(),
      components,
      wiringPlan: generated.wiringPlan.map((step) => step.trim()),
      estimatedComponentSubtotal: subtotal,
      estimateNote: 'Estimate uses current catalog prices for matched components only. Shipping, taxes, packaging, coding, construction, and other checkout charges are not included.',
      customBuildingPrompt: [
        `Project objective: ${generated.objective.trim()}`,
        `Expected behaviour: ${generated.expectedBehavior.trim()}`,
        `Required components: ${components.map((component) => `${component.name} × ${component.quantity}`).join('; ')}`,
        `Wiring documentation: Include a clear wiring plan for ${components.map((component) => component.name).join(', ')}. Confirm compatibility wherever specifications are uncertain.`,
        'Building preference: I will select parts only, complete built model, or parts plus coding in the existing Custom Building order form.',
        `Special requirements: ${idea}`,
        'Do not include Arduino source code in this project brief.',
      ].join('\n'),
    };
    const latestAccess = await getAiAccess(userId);
    if (latestAccess.quotaKey !== access.quotaKey || latestAccess.plan !== access.plan) {
      throw Object.assign(new Error('Your project-building entitlement changed while the project was being prepared. Please refresh and try again.'), { status: 403, code: 'AI_ENTITLEMENT_CHANGED' });
    }
    await withMongoTransaction(async (session) => {
      const now = new Date();
      const quotaUpdate = await AIProjectQuota.updateOne(
        { userId, quotaKey: access.quotaKey, pendingBuilds: { $gte: 1 } },
        { $inc: { pendingBuilds: -1, successfulBuilds: 1 } },
        { session },
      );
      if (quotaUpdate.modifiedCount !== 1) throw Object.assign(new Error('Project usage could not be recorded safely.'), { status: 409 });
      if (access.trialMode) {
        const trialUpdate = await AITrial.updateOne(
          { userId, _id: access.trialRecord._id, status: 'active', expiresAt: { $gt: now }, successfulBuilds: { $lt: 2 } },
          { $inc: { successfulBuilds: 1 } },
          { session },
        );
        if (trialUpdate.modifiedCount !== 1) throw Object.assign(new Error('Your trial has expired or used its project-build allowance.'), { status: 403, code: 'AI_TRIAL_EXPIRED' });
      }
      await consumeAiBill(session, userId, build._id);
      const buildUpdate = await AIProjectBuild.updateOne(
        { _id: build._id, status: 'generating' },
        { $set: { status: 'succeeded', result } },
        { session },
      );
      if (buildUpdate.modifiedCount !== 1) throw Object.assign(new Error('Project build could not be completed safely.'), { status: 409 });
    });
    const [latestAccessAfterBuild, latestBills] = await Promise.all([getAiAccess(userId), getAiBillSummary(userId)]);
    return res.json({ ...result, entitlements: aiAccessResponse(latestAccessAfterBuild, latestBills).entitlements });
  } catch (error) {
    if (quotaReserved) {
      await withMongoTransaction(async (session) => {
        await AIProjectQuota.updateOne({ userId, quotaKey: build.quotaKey, pendingBuilds: { $gte: 1 } }, { $inc: { pendingBuilds: -1 } }, { session });
        if (build) await AIProjectBuild.updateOne({ _id: build._id, status: 'generating' }, { $set: { status: 'failed' } }, { session });
      });
    } else if (build) {
      await AIProjectBuild.updateOne({ _id: build._id, status: 'generating' }, { $set: { status: 'failed' } });
    }
    if (error.code === 11000) {
      const duplicate = await AIProjectBuild.findOne({ userId, idempotencyKey }).lean();
      if (duplicate?.requestHash === digest && duplicate.status === 'succeeded') return res.json(duplicate.result);
      return res.status(409).json({ message: 'This project request is already being processed.' });
    }
    if (error.status) return res.status(error.status).json({ code: error.code || 'AI_PROJECT_ERROR', message: error.message });
    console.error('AI Project Builder failed:', error?.name || 'ProviderError');
    return res.status(502).json({ code: 'AI_PROVIDER_UNAVAILABLE', message: 'The AI Project Builder is temporarily unavailable. Please try again.' });
  }
});

const normalizePersistedCartItem = async (item, userId) => {
  const quantity = Number(item?.quantity);
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw Object.assign(new Error('A cart item or quantity is invalid.'), { status: 400 });
  }
  const image = typeof item.image === 'string' ? item.image.slice(0, 2000) : '';
  if (item.promoReservationId) {
    if (quantity !== 1) throw Object.assign(new Error('Promo Codes can only be purchased one at a time.'), { status: 400 });
    const promo = await PromoCode.findOne({
      reservationId: item.promoReservationId,
      status: 'reserved',
      'reservationOwner.userId': userId,
      reservationExpiresAt: { $gt: new Date() },
    }).select('_id reservationId amountPaise purchaseType recipientType').lean();
    if (!promo) throw Object.assign(new Error('This Promo Code reservation is no longer available.'), { status: 409 });
    return {
      id: `promo-${promo.reservationId}`,
      name: 'Digital Wallet Credit',
      category: 'Promo Code',
      price: money(promo.amountPaise),
      quantity: 1,
      image,
      promoCodeId: String(promo._id),
      promoReservationId: promo.reservationId,
      purchaseType: promo.purchaseType,
      recipientType: promo.recipientType,
    };
  }
  if (item.discountOfferId) {
    if (!mongoose.isValidObjectId(item.discountOfferId)) {
      throw Object.assign(new Error('A Discount Promo Code offer is invalid.'), { status: 400 });
    }
    const offer = await DiscountCodeOffer.findById(item.discountOfferId)
      .select('name sellingPricePaise discountType discountValuePaise discountPercent availableQuantity active startsAt expiresAt')
      .lean();
    if (!offer) throw Object.assign(new Error('This Discount Promo Code is no longer available.'), { status: 409 });
    const available = offer.active && offer.startsAt <= new Date() && offer.expiresAt > new Date()
      ? offer.availableQuantity
      : 0;
    return {
      id: `discount-${offer._id}`,
      discountOfferId: String(offer._id),
      name: offer.name,
      category: 'Discount Promo Code',
      price: money(offer.sellingPricePaise),
      quantity,
      image,
      availableQuantity: available,
      status: available > 0 ? 'In Stock' : 'Out of Stock',
      discountLabel: offer.discountType === 'fixed'
        ? `₹${money(offer.discountValuePaise)} off`
        : `${offer.discountPercent}% off`,
    };
  }
  if (item.customOrderId) {
    if (!mongoose.isValidObjectId(item.customOrderId)) {
      throw Object.assign(new Error('A custom item is invalid.'), { status: 400 });
    }
    const customOrder = await CustomOrder.findOne({
      _id: item.customOrderId,
      userId,
      status: 'Accepted',
    }).select('requestedItem price').lean();
    if (!customOrder) throw Object.assign(new Error('This accepted custom item is no longer available.'), { status: 409 });
    return {
      id: `custom-${customOrder._id}`,
      customOrderId: String(customOrder._id),
      name: customOrder.requestedItem,
      category: 'Custom Order',
      price: customOrder.price,
      quantity,
      image,
    };
  }
  const productId = typeof item.id === 'string' ? item.id.trim() : '';
  if (!productId || productId.length > 120) {
    throw Object.assign(new Error('A cart product is invalid.'), { status: 400 });
  }
  const product = await InventoryItem.findOne({ productId }).lean();
  if (!product) throw Object.assign(new Error('A cart product is no longer available.'), { status: 409 });
  return {
    id: product.productId,
    name: product.name,
    category: product.category || 'Other Components',
    price: money(product.pricePaise),
    description: product.description || '',
    quantity,
    image: image || product.images?.[0] || '',
    inventoryProduct: true,
    stock: product.stock,
    status: product.status,
    images: product.images || [],
  };
};

app.get('/api/cart', requireSession, requireDatabase, async (req, res) => {
  const cart = await UserCart.findOne({ userId: req.session.sub }).lean();
  return res.json({ items: cart?.items || [] });
});

app.put('/api/cart', requireSession, requireDatabase, async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length > 100) return res.status(400).json({ message: 'The cart contents are invalid.' });
  const normalized = [];
  for (const item of items) normalized.push(await normalizePersistedCartItem(item, req.session.sub));
  const cart = await UserCart.findOneAndUpdate(
    { userId: req.session.sub },
    { $set: { items: normalized } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return res.json({ items: cart.items });
});

app.post('/api/ai/add-components-to-cart', requireSession, requireDatabase, async (req, res) => {
  const idempotencyKey = req.body?.idempotencyKey;
  const requested = req.body?.items;
  if (!aiIdempotencyKey(idempotencyKey) || !Array.isArray(requested) || !requested.length || requested.length > 30) {
    return res.status(400).json({ message: 'Choose valid project components and try again.' });
  }
  const access = await getAiAccess(req.session.sub);
  if (!access.canAddComponents) return res.status(403).json({ code: 'AI_CART_UNAVAILABLE', message: 'AI-assisted cart addition requires an active Pro or Exclusive plan, or its eligible trial.' });
  const combined = new Map();
  for (const entry of requested) {
    const productId = typeof entry?.productId === 'string' ? entry.productId.trim() : '';
    const quantity = Number(entry?.quantity);
    const currentQuantity = Number(entry?.currentQuantity || 0);
    if (!productId || productId.length > 120 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99
      || !Number.isInteger(currentQuantity) || currentQuantity < 0 || currentQuantity > 99) {
      return res.status(400).json({ message: 'A project component or quantity is invalid.' });
    }
    const existing = combined.get(productId) || { productId, quantity: 0, currentQuantity };
    existing.quantity += quantity;
    existing.currentQuantity = Math.max(existing.currentQuantity, currentQuantity);
    if (existing.quantity > 99) return res.status(400).json({ message: 'Requested component quantity exceeds the allowed limit.' });
    combined.set(productId, existing);
  }
  const items = [...combined.values()];
  const digest = requestDigest(items);
  const previous = await AIComponentCartAction.findOne({ userId: req.session.sub, idempotencyKey }).lean();
  if (previous) {
    if (previous.requestHash !== digest) return res.status(409).json({ message: 'This cart request key was already used for different components.' });
    return res.json(previous.result);
  }
  const savedCart = await UserCart.findOne({ userId: req.session.sub }).lean();
  const savedQuantityById = new Map((savedCart?.items || []).map((item) => [item.id, Number(item.quantity) || 0]));
  const products = await InventoryItem.find({ productId: { $in: items.map((item) => item.productId) } }).select('productId name category description pricePaise stock status images').lean();
  const byId = new Map(products.map((product) => [product.productId, product]));
  const added = [];
  const unavailable = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    const currentQuantity = savedQuantityById.get(item.productId) || 0;
    const remaining = product ? Math.max(0, product.stock - currentQuantity) : 0;
    if (!product) {
      unavailable.push({ productId: item.productId, requestedQuantity: item.quantity, reason: 'This product is no longer available in the catalog.' });
    } else if (product.status === 'Out of Stock' || remaining < item.quantity) {
      unavailable.push({ productId: item.productId, name: product.name, requestedQuantity: item.quantity, reason: product.status === 'Out of Stock' ? 'This product is out of stock.' : `Only ${remaining} additional unit(s) are available.` });
    } else {
      added.push({
        id: product.productId,
        name: product.name,
        category: product.category,
        description: product.description || '',
        price: money(product.pricePaise),
        quantity: item.quantity,
        stock: product.stock,
        status: product.status,
        images: (product.images || []).slice(0, 4),
        inventoryProduct: true,
      });
    }
  }
  const result = { added, unavailable, message: added.length ? 'Catalog availability verified. These products can be added to your cart.' : 'No requested components could be added.' };
  try {
    await AIComponentCartAction.create([{ userId: req.session.sub, idempotencyKey, requestHash: digest, result }]);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const duplicate = await AIComponentCartAction.findOne({ userId: req.session.sub, idempotencyKey }).lean();
    if (duplicate?.requestHash !== digest) return res.status(409).json({ message: 'This cart request key was already used for different components.' });
    return res.json(duplicate.result);
  }
  return res.json(result);
});

app.post('/api/ai/checkout-assistance', requireSession, requireDatabase, async (req, res) => {
  const access = await getAiAccess(req.session.sub);
  if (!access.canAssistCheckout) return res.status(403).json({ code: 'AI_CHECKOUT_UNAVAILABLE', message: 'AI-assisted checkout preparation is an Exclusive entitlement.' });
  if (typeof req.body?.projectDescription !== 'string' || req.body.projectDescription.length > 4000) return res.status(400).json({ message: 'Project requirements are invalid. Rebuild the project and try again.' });
  const requestedItems = req.body?.items;
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 50
    || requestedItems.some((item) => item?.promoReservationId || item?.promoCodeId || item?.discountOfferId)) {
    return res.status(400).json({ message: 'Add eligible physical project components before starting checkout assistance.' });
  }
  const service = ['parts', 'coding', 'building', 'full'].includes(req.body?.service) ? req.body.service : 'parts';
  const paymentMethod = req.body?.paymentMethod == null ? null : String(req.body.paymentMethod);
  if (paymentMethod !== null && !['Wallet', 'Online Payment'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Online Payment.' });
  const { safeItems } = await resolveOrderItems(requestedItems.map((item) => ({ id: item?.id, quantity: item?.quantity })), req.session.sub);
  const estimate = calculateOrder(safeItems, service);
  return res.json({
    checkoutPath: '/checkout',
    items: safeItems,
    service,
    preferredPaymentMethod: paymentMethod,
    projectDescription: req.body.projectDescription,
    estimate: {
      subtotal: money(estimate.subtotalPaise),
      codingCharge: money(estimate.codingChargePaise),
      buildingCharge: money(estimate.buildingChargePaise),
      deliveryCharge: money(estimate.deliveryChargePaise),
      totalBeforeDiscounts: money(estimate.totalPaise),
    },
    paymentOptions: ['Wallet', 'Online Payment'],
    requiresUserServiceSelection: true,
    requiresFinalConfirmation: true,
    orderPlaced: false,
  });
});

app.post('/api/ai/action', requireSession, requireDatabase, async (_req, res) => {
  return res.status(403).json({ code: 'AI_FEATURE_LOCKED', message: 'This AI feature is not enabled. Use the AI Project Builder for project design.' });
});

const broadcastWalletPaymentRequestUpdate = (request, data) => {
  for (const userId of new Set([request.requesterUserId, request.payerUserId].filter(Boolean))) {
    broadcastSse('wallet_payment_request_updated', data, userId);
  }
};

app.get('/api/wallet/access', requireSession, requireDatabase, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
  return res.json({ setupRequired: !wallet?.pinHash });
});

app.get('/api/wallet/identity', requireSession, requireDatabase, async (req, res) => {
  const requestedWalletId = normalizeWalletId(req.query.walletId);
  const wallet = await Wallet.findOne(requestedWalletId ? { walletId: requestedWalletId } : { userId: req.session.sub })
    .select('walletId balancePaise restrictedBalancePaise pinHash userId').lean();
  if (!wallet?.walletId) return res.status(404).json({ message: 'This Wallet ID does not exist. Please check and try again.' });
  const owner = await User.findOne({ googleId: wallet.userId }).select('name').lean();
  const identity = {
    walletId: wallet.walletId,
    ownerName: owner?.name || 'Innovation Labs wallet owner',
  };
  if (wallet.userId === req.session.sub) {
    const limitState = await getWalletLimitStatus(wallet.userId, wallet.balancePaise);
    identity.availableBalance = money(limitState.availableBalancePaise);
    identity.hasPin = Boolean(wallet.pinHash);
  }
  return res.json(identity);
});

app.post('/api/checkout/wallet-id/verify', requireSession, requireDatabase, async (req, res) => {
  const walletId = normalizeWalletId(req.body?.walletId);
  const checkoutReference = typeof req.body?.checkoutReference === 'string' ? req.body.checkoutReference.trim() : '';
  if (!walletId || !checkoutReference) return res.status(400).json({ message: 'A Wallet ID and checkout reference are required.' });
  if (!validateWalletId(walletId)) return res.status(400).json({ message: 'Enter a valid Innovation Labs Wallet ID.' });
  const [wallet, attempt, requester] = await Promise.all([
    Wallet.findOne({ walletId }).select('walletId userId').lean(),
    CheckoutAttempt.findOne({ reference: checkoutReference, userId: req.session.sub, status: { $in: ['Open', 'Payment Initiated'] } }).select('reference totalPaise expiresAt').lean(),
    User.findOne({ googleId: req.session.sub }).select('email').lean(),
  ]);
  if (!attempt) return res.status(409).json({ message: 'This checkout is no longer active.' });
  if (attempt.expiresAt && attempt.expiresAt <= new Date()) return res.status(409).json({ message: 'This checkout payment session has expired.' });
  if (!wallet?.walletId) return res.status(404).json({ message: 'This Wallet ID does not exist. Please check and try again.' });
  if (wallet.userId === req.session.sub) return res.status(400).json({ message: 'You cannot use your own Wallet ID to pay for this checkout.' });
  const owner = await User.findOne({ googleId: wallet.userId }).select('name email').lean();
  const sessionEmail = typeof req.session.email === 'string' ? req.session.email.trim().toLowerCase() : '';
  if (!requester?.email || requester.email.trim().toLowerCase() !== sessionEmail) {
    return res.status(403).json({ message: 'Your registered email could not be verified. Please sign in again.' });
  }
  if (!owner?.email) return res.status(404).json({ message: 'This Wallet ID is not linked to a verified Innovation Labs account.' });
  return res.json({
    walletId: wallet.walletId,
    ownerName: safeRecipientName(owner?.name),
    checkoutReference: attempt.reference,
    amount: money(attempt.totalPaise),
  });
});

app.post('/api/checkout/wallet-id/request', requireSession, requireDatabase, async (req, res) => {
  const walletId = normalizeWalletId(req.body?.walletId);
  const checkoutReference = typeof req.body?.checkoutReference === 'string' ? req.body.checkoutReference.trim() : '';
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey : '';
  if (!walletId || !checkoutReference || !idempotencyKey) return res.status(400).json({ message: 'A Wallet ID, checkout reference, and payment reference are required.' });
  const existing = await WalletPaymentRequest.findOne({ idempotencyKey, requesterUserId: req.session.sub }).lean();
  if (existing) return res.json({
    requestId: existing.requestId,
    status: existing.status,
    paymentStatus: existing.paymentStatus || 'PENDING',
    amount: money(existing.amountPaise),
    checkoutReference: existing.checkoutReference,
    expiresAt: existing.expiresAt,
    serverTime: new Date().toISOString(),
    duplicate: true,
  });
  const now = new Date();
  const expiredRequests = await WalletPaymentRequest.find({
    checkoutReference,
    requesterUserId: req.session.sub,
    status: { $in: ['Pending', 'Processing'] },
    expiresAt: { $lte: now },
  }).select('requestId requesterUserId payerUserId').lean();
  if (expiredRequests.length) {
    await WalletPaymentRequest.updateMany(
      { requestId: { $in: expiredRequests.map((request) => request.requestId) }, status: { $in: ['Pending', 'Processing'] } },
      {
        $set: { status: 'Expired', paymentStatus: 'FAILED' },
        $unset: { activeCheckoutKey: 1 },
        $push: { statusHistory: { status: 'Payment Expired', at: now } },
      },
    );
    expiredRequests.forEach((request) => broadcastWalletPaymentRequestUpdate(request, {
      requestId: request.requestId,
      checkoutReference,
      status: 'Expired',
      serverTime: now.toISOString(),
    }));
  }
  const activeRequest = await WalletPaymentRequest.findOne({
    checkoutReference,
    requesterUserId: req.session.sub,
    status: { $in: ['Pending', 'Processing'] },
    expiresAt: { $gt: now },
  }).lean();
  if (activeRequest && activeRequest.payerWalletId !== walletId) {
    return res.status(409).json({ message: 'Cancel the active Wallet ID payment request before choosing another Wallet ID.' });
  }
  if (activeRequest) return res.json({
    requestId: activeRequest.requestId,
    status: activeRequest.status,
    paymentStatus: activeRequest.paymentStatus || 'PENDING',
    amount: money(activeRequest.amountPaise),
    checkoutReference: activeRequest.checkoutReference,
    payerWalletId: activeRequest.payerWalletId,
    expiresAt: activeRequest.expiresAt,
    serverTime: now.toISOString(),
    duplicate: true,
  });
  const [wallet, attempt] = await Promise.all([
    Wallet.findOne({ walletId }).select('walletId userId').lean(),
    CheckoutAttempt.findOne({ reference: checkoutReference, userId: req.session.sub, status: { $in: ['Open', 'Payment Initiated'] } })
      .select('reference totalPaise expiresAt paymentStatus').lean(),
  ]);
  if (!attempt || attempt.paymentStatus === 'Paid') return res.status(409).json({ message: 'This checkout is no longer active.' });
  if (attempt.expiresAt && attempt.expiresAt <= now) return res.status(409).json({ message: 'This checkout payment session has expired.' });
  if (!wallet?.walletId) return res.status(404).json({ message: 'This Wallet ID does not exist. Please check and try again.' });
  if (wallet.userId === req.session.sub) return res.status(400).json({ message: 'You cannot use your own Wallet ID to pay for this checkout.' });
  const requestId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + 4 * 60 * 1000);
  let request;
  try {
    request = await withMongoTransaction(async (session) => {
      const currentAttempt = await CheckoutAttempt.findOne({
        reference: checkoutReference,
        userId: req.session.sub,
        status: { $in: ['Open', 'Payment Initiated'] },
        paymentStatus: { $ne: 'Paid' },
      }).session(session);
      if (!currentAttempt || (currentAttempt.expiresAt && currentAttempt.expiresAt <= now)) {
        throw Object.assign(new Error('This checkout is no longer active.'), { status: 409 });
      }
      const created = await WalletPaymentRequest.create([{
        requestId,
        idempotencyKey,
        activeCheckoutKey: `${checkoutReference}:${req.session.sub}`,
        checkoutReference,
        requesterUserId: req.session.sub,
        payerUserId: wallet.userId,
        payerWalletId: wallet.walletId,
        amountPaise: currentAttempt.totalPaise,
        expiresAt,
        paymentStatus: 'PENDING',
        statusHistory: [
          { status: 'Wallet ID Entered', at: now },
          { status: 'Wallet ID Verified', at: now },
          { status: 'Awaiting Payment', at: now },
        ],
      }], { session });
      currentAttempt.stage = 'Payment Initiated';
      currentAttempt.paymentStatus = 'Pending';
      currentAttempt.expiresAt = undefined;
      await currentAttempt.save({ session });
      await Notification.create([{
        userId: wallet.userId,
        message: `A Wallet ID payment request for ${money(currentAttempt.totalPaise)} is waiting for your approval.`,
        type: 'wallet_payment_request',
        data: { requestId, checkoutReference },
      }], { session });
      return created[0].toObject();
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const active = await WalletPaymentRequest.findOne({
      checkoutReference,
      requesterUserId: req.session.sub,
      status: { $in: ['Pending', 'Processing'] },
      expiresAt: { $gt: new Date() },
    }).lean();
    if (active) request = active;
    else {
      const duplicate = await WalletPaymentRequest.findOne({ idempotencyKey, requesterUserId: req.session.sub }).lean();
      if (!duplicate) throw error;
      request = duplicate;
    }
  }
  broadcastSse('wallet_payment_request', { requestId: request.requestId, amount: money(request.amountPaise), checkoutReference }, wallet.userId);
  broadcastWalletPaymentRequestUpdate(request, {
    requestId: request.requestId,
    checkoutReference,
    status: request.status,
    amount: money(request.amountPaise),
    expiresAt: request.expiresAt,
    serverTime: new Date().toISOString(),
  });
  return res.status(201).json({
    requestId: request.requestId,
    status: request.status,
    paymentStatus: request.paymentStatus || 'PENDING',
    amount: money(request.amountPaise),
    checkoutReference,
    payerWalletId: request.payerWalletId,
    expiresAt: request.expiresAt,
    serverTime: new Date().toISOString(),
    duplicate: request.requestId !== requestId,
  });
});

app.get('/api/checkout/wallet-id/status', requireSession, requireDatabase, async (req, res) => {
  const reference = typeof req.query.reference === 'string' ? req.query.reference.trim() : '';
  let request = await WalletPaymentRequest.findOne({ checkoutReference: reference, requesterUserId: req.session.sub })
    .sort({ createdAt: -1 }).select('requestId status paymentStatus amountPaise orderId expiresAt payerWalletId payerUserId requesterUserId').lean();
  const now = new Date();
  if (!request) return res.json({ status: 'Not Started', serverTime: now.toISOString() });
  if (['Pending', 'Processing'].includes(request.status) && request.expiresAt <= now) {
    const expiredRequest = await WalletPaymentRequest.findOneAndUpdate(
      { requestId: request.requestId, status: { $in: ['Pending', 'Processing'] }, expiresAt: { $lte: now } },
      {
        $set: { status: 'Expired', paymentStatus: 'FAILED' },
        $unset: { activeCheckoutKey: 1 },
        $push: { statusHistory: { status: 'Payment Expired', at: now } },
      },
      { new: true },
    ).select('requestId status paymentStatus amountPaise orderId expiresAt payerWalletId payerUserId requesterUserId').lean() || request;
    request = expiredRequest.status === 'Expired' ? expiredRequest : await WalletPaymentRequest.findById(request._id)
      .select('requestId status paymentStatus amountPaise orderId expiresAt payerWalletId payerUserId requesterUserId').lean() || expiredRequest;
    if (request.status === 'Expired') broadcastWalletPaymentRequestUpdate(request, {
      requestId: request.requestId,
      checkoutReference: reference,
      status: request.status,
      serverTime: now.toISOString(),
    });
  }
  return res.json({
    requestId: request.requestId,
    status: request.status,
    paymentStatus: request.paymentStatus || (request.status === 'Approved' ? 'SUCCESS' : request.status === 'Processing' ? 'PROCESSING' : request.status === 'Pending' ? 'PENDING' : 'FAILED'),
    amount: money(request.amountPaise),
    orderId: request.orderId || null,
    expiresAt: request.expiresAt,
    payerWalletId: request.payerWalletId || null,
    serverTime: now.toISOString(),
  });
});

app.get('/api/wallet/payment-requests/pending', requireSession, requireDatabase, async (req, res) => {
  const now = new Date();
  const expiredRequests = await WalletPaymentRequest.find(
    { payerUserId: req.session.sub, status: { $in: ['Pending', 'Processing'] }, expiresAt: { $lte: now } },
  ).select('requestId checkoutReference requesterUserId payerUserId').lean();
  if (expiredRequests.length) await WalletPaymentRequest.updateMany(
    { requestId: { $in: expiredRequests.map((request) => request.requestId) }, status: { $in: ['Pending', 'Processing'] } },
    {
      $set: { status: 'Expired', paymentStatus: 'FAILED' },
      $unset: { activeCheckoutKey: 1 },
      $push: { statusHistory: { status: 'Payment Expired', at: now } },
    },
  );
  expiredRequests.forEach((request) => broadcastWalletPaymentRequestUpdate(request, {
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    status: 'Expired',
    serverTime: now.toISOString(),
  }));
  const requests = await WalletPaymentRequest.find({ payerUserId: req.session.sub, status: { $in: ['Pending', 'Processing'] }, expiresAt: { $gt: now } })
    .sort({ createdAt: -1 }).limit(20).lean();
  const recentRequests = await WalletPaymentRequest.find({
    payerUserId: req.session.sub,
    status: { $nin: ['Pending', 'Processing'] },
  }).sort({ createdAt: -1 }).limit(10)
    .select('requestId checkoutReference requesterUserId amountPaise status paymentStatus paymentReference createdAt approvedAt').lean();
  const requesterIds = [...new Set([...requests, ...recentRequests].map((request) => request.requesterUserId))];
  const users = await User.find({ googleId: { $in: requesterIds } }).select('googleId name').lean();
  const names = new Map(users.map((user) => [user.googleId, safeRecipientName(user.name)]));
  return res.json({ requests: requests.map((request) => ({
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    amount: money(request.amountPaise),
    requesterName: names.get(request.requesterUserId) || 'Innovation Labs customer',
    payerWalletId: request.payerWalletId,
    status: request.status,
    paymentStatus: request.paymentStatus || (request.status === 'Approved' ? 'SUCCESS' : request.status === 'Processing' ? 'PROCESSING' : request.status === 'Pending' ? 'PENDING' : 'FAILED'),
    expiresAt: request.expiresAt,
  })), recentRequests: recentRequests.map((request) => ({
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    amount: money(request.amountPaise),
    requesterName: names.get(request.requesterUserId) || 'Innovation Labs customer',
    status: request.status,
    paymentStatus: request.paymentStatus || (request.status === 'Approved' ? 'SUCCESS' : 'FAILED'),
    transactionId: request.paymentReference || null,
    createdAt: request.createdAt,
    completedAt: request.approvedAt || null,
  })) });
});

app.post('/api/wallet/payment-requests/:requestId/cancel', requireSession, requireDatabase, async (req, res) => {
  const now = new Date();
  const request = await WalletPaymentRequest.findOneAndUpdate(
    { requestId: req.params.requestId, $or: [{ payerUserId: req.session.sub }, { requesterUserId: req.session.sub }], status: 'Pending', expiresAt: { $gt: now } },
    {
      $set: { status: 'Cancelled', paymentStatus: 'FAILED' },
      $unset: { activeCheckoutKey: 1 },
      $push: { statusHistory: { status: 'Payment Cancelled', at: now } },
    },
    { new: true },
  ).lean();
  if (!request) return res.status(409).json({ message: 'This payment request is no longer pending.' });
  broadcastWalletPaymentRequestUpdate(request, {
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    status: request.status,
    serverTime: now.toISOString(),
  });
  return res.json({ requestId: request.requestId, status: request.status, serverTime: now.toISOString() });
});

app.post('/api/wallet/payment-requests/:requestId/reject', requireSession, requireDatabase, async (req, res) => {
  const now = new Date();
  const request = await WalletPaymentRequest.findOneAndUpdate(
    { requestId: req.params.requestId, payerUserId: req.session.sub, status: 'Pending', expiresAt: { $gt: now } },
    {
      $set: { status: 'Rejected', paymentStatus: 'FAILED', rejectedAt: now },
      $unset: { activeCheckoutKey: 1 },
      $push: { statusHistory: { status: 'Payment Rejected', at: now } },
    },
    { new: true },
  ).lean();
  if (!request) return res.status(409).json({ message: 'This payment request is no longer pending.' });
  broadcastWalletPaymentRequestUpdate(request, {
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    status: request.status,
    serverTime: now.toISOString(),
  });
  return res.json({ requestId: request.requestId, status: request.status, serverTime: now.toISOString() });
});

app.post('/api/wallet/payment-requests/:requestId/approve', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const pin = req.body?.pin;
  if (!validatePin(pin)) return res.status(400).json({ message: 'Wallet PIN must contain exactly 4 digits.' });
  const now = new Date();
  const priorRequest = await WalletPaymentRequest.findOne({ requestId: req.params.requestId, payerUserId: req.session.sub }).lean();
  if (!priorRequest) return res.status(404).json({ message: 'Payment request was not found.' });
  if (priorRequest.status === 'Approved' && priorRequest.orderId) {
    const existing = await Order.findOne({ orderId: priorRequest.orderId }).lean();
    if (existing) return res.json({ order: existing, duplicate: true });
  }
  const claimed = await WalletPaymentRequest.findOneAndUpdate(
    { requestId: req.params.requestId, payerUserId: req.session.sub, status: 'Pending', expiresAt: { $gt: now } },
    {
      $set: { status: 'Processing', paymentStatus: 'PROCESSING' },
      $push: { statusHistory: { status: 'Payment Processing', at: now } },
    },
    { new: true },
  ).lean();
  if (!claimed) {
    await WalletPaymentRequest.updateOne(
      { requestId: req.params.requestId, payerUserId: req.session.sub, status: { $in: ['Pending', 'Processing'] }, expiresAt: { $lte: now } },
      {
        $set: { status: 'Expired', paymentStatus: 'FAILED' },
        $unset: { activeCheckoutKey: 1 },
        $push: { statusHistory: { status: 'Payment Expired', at: now } },
      },
    );
    return res.status(409).json({ message: 'This payment request has expired or was already completed.' });
  }
  broadcastWalletPaymentRequestUpdate(claimed, {
    requestId: claimed.requestId,
    checkoutReference: claimed.checkoutReference,
    status: claimed.status,
    serverTime: now.toISOString(),
  });
  try {
    const result = await withMongoTransaction(async (session) => {
      const request = await WalletPaymentRequest.findOne({ requestId: req.params.requestId, payerUserId: req.session.sub }).session(session);
      if (!request) throw Object.assign(new Error('Payment request was not found.'), { status: 404 });
      if (request.status !== 'Processing' || request.expiresAt <= new Date()) {
        if (['Pending', 'Processing'].includes(request.status) && request.expiresAt <= new Date()) {
          request.status = 'Expired';
          request.paymentStatus = 'FAILED';
          request.activeCheckoutKey = undefined;
          request.statusHistory.push({ status: 'Payment Expired', at: new Date() });
          await request.save({ session });
        }
        throw Object.assign(new Error('This payment request has expired or was already completed.'), { status: 409 });
      }
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (wallet?.lockedUntil && wallet.lockedUntil > new Date()) {
        throw Object.assign(new Error('Wallet security verification is temporarily locked. Please try again later.'), { status: 429 });
      }
      if (!wallet?.pinHash || !verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      const limitState = await getWalletLimitStatus(req.session.sub, wallet.balancePaise, session);
      const spendCheck = enforceAvailableWalletSpendLimit(wallet.balancePaise, request.amountPaise, limitState, 'Wallet balance');
      if (!spendCheck.allowed || wallet.balancePaise < request.amountPaise) {
        throw Object.assign(new Error(spendCheck.message || 'Insufficient wallet balance for this payment.'), { status: 402 });
      }
      const attempt = await CheckoutAttempt.findOne({ reference: request.checkoutReference, userId: request.requesterUserId, status: { $in: ['Open', 'Payment Initiated'] }, paymentStatus: 'Pending' }).session(session);
      if (!attempt || (attempt.expiresAt && attempt.expiresAt <= new Date())) throw Object.assign(new Error('The original checkout is no longer active.'), { status: 409 });
      const items = (attempt.items || []).map((item) => ({ ...item, price: Number(item.unitPricePaise || 0) / 100, quantity: Number(item.quantity || 0) }));
      const { safeItems, customOrders } = await resolveOrderItems(items, request.requesterUserId);
      if (orderRequiresDelivery(safeItems) && !validateAddress(attempt.address)) throw Object.assign(new Error('The checkout delivery address is missing or incomplete.'), { status: 409 });
      const calculated = calculateOrder(safeItems, attempt.service);
      if (attempt.totalPaise !== request.amountPaise || calculated.totalPaise < request.amountPaise) {
        throw Object.assign(new Error('The checkout amount no longer matches the order.'), { status: 409 });
      }
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems, { validateProductSnapshot: true });
      if (request.expiresAt <= new Date()) {
        throw Object.assign(new Error('This payment request has expired.'), { status: 409 });
      }
      const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const before = wallet.balancePaise;
      const walletAfter = await Wallet.findOneAndUpdate(
        { _id: wallet._id, balancePaise: { $gte: request.amountPaise }, availableBalancePaise: { $gte: request.amountPaise } },
        { $inc: { balancePaise: -request.amountPaise, availableBalancePaise: -request.amountPaise }, $set: { failedPinAttempts: 0, lockedUntil: null } },
        { new: true, session },
      );
      if (!walletAfter) throw Object.assign(new Error('Insufficient wallet balance for this payment.'), { status: 402 });
      const owner = await User.findOne({ googleId: request.requesterUserId }).session(session).lean();
      const [order] = await Order.create([{
        orderId, orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: request.requesterUserId, userName: owner?.name || 'Innovation Labs customer', userEmail: owner?.email || '',
        items: orderItemsSnapshot(safeItems), address: orderRequiresDelivery(safeItems) ? attempt.address : null,
        deliveryRequired: orderRequiresDelivery(safeItems), service: attempt.service, projectDescription: '',
        subtotal: money(calculated.subtotalPaise), discountAmountPaise: Math.max(0, calculated.totalPaise - request.amountPaise),
        codingCharge: money(calculated.codingChargePaise), buildingCharge: money(calculated.buildingChargePaise),
        deliveryCharge: money(calculated.deliveryChargePaise), total: money(request.amountPaise),
        paymentStatus: 'Paid', paymentMethod: 'Wallet', payerWalletId: wallet.walletId,
        verifiedAmountPaidPaise: request.amountPaise, paymentVerifiedAt: new Date(),
        originalPaymentReference: `wallet-id-payment:${request.requestId}`, walletBalanceAfterPaise: walletAfter.balancePaise,
        inventoryDeductedAt, orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Order paid by an approved Wallet ID payment request', createdAt: new Date() }],
        checkoutReference: request.checkoutReference,
      }], { session });
      await WalletTransaction.create([{
        userId: req.session.sub, type: 'Purchase', amountPaise: -request.amountPaise,
        balanceBeforePaise: before, balanceAfterPaise: walletAfter.balancePaise, payerWalletId: wallet.walletId,
        referenceId: `wallet-id-payment:${request.requestId}`, orderId, description: `Wallet ID checkout payment for ${orderId}`, status: 'Successful',
      }], { session });
      await createInvoiceForOrder(session, order);
      if (customOrders.length) await CustomOrder.updateMany({ _id: { $in: customOrders.map((item) => item._id) }, userId: request.requesterUserId, status: 'Accepted' }, { $set: { status: 'Ordered', orderedAt: new Date() } }, { session });
      await Notification.create([{ userId: request.requesterUserId, message: `Order ${orderId} was approved and paid from ${wallet.walletId}.` }], { session });
      request.status = 'Approved';
      request.paymentStatus = 'SUCCESS';
      request.orderId = orderId;
      request.paymentReference = `wallet-id-payment:${request.requestId}`;
      request.approvedAt = new Date();
      request.activeCheckoutKey = undefined;
      request.statusHistory.push(
        { status: 'Payment Approved', at: new Date() },
        { status: 'Payment Successful', at: new Date() },
      );
      await request.save({ session });
      attempt.status = 'Completed'; attempt.paymentStatus = 'Paid'; attempt.paymentReference = request.paymentReference; attempt.completedAt = new Date(); await attempt.save({ session });
      const cartItems = await removeOrderedItemsFromCart(session, request.requesterUserId, order.items);
      return {
        order: order.toObject(),
        cartItems,
        wallet: walletAfter.toObject(),
        duplicate: false,
        requesterUserId: request.requesterUserId,
        payerUserId: request.payerUserId,
        requestId: request.requestId,
      };
    });
    broadcastSse('cart_updated', { items: result.cartItems || [] }, result.requesterUserId || result.order.userId);
    broadcastSse('checkout_payment_completed', { checkoutReference: result.order.checkoutReference, orderId: result.order.orderId, amount: result.order.total }, result.requesterUserId || result.order.userId);
    broadcastWalletPaymentRequestUpdate({
      requesterUserId: result.requesterUserId || result.order.userId,
      payerUserId: result.payerUserId || req.session.sub,
    }, {
      requestId: result.requestId,
      checkoutReference: result.order.checkoutReference,
      status: 'Approved',
      orderId: result.order.orderId,
      serverTime: new Date().toISOString(),
    });
    broadcastSse('wallet_balance_updated', { userId: req.session.sub, balance: money(result.wallet.balancePaise) }, req.session.sub);
    return res.status(result.duplicate ? 200 : 201).json({ order: result.order, wallet: walletView(result.wallet), duplicate: result.duplicate });
  } catch (error) {
    const failedAt = new Date();
    if (error.status === 401) {
      const pinWallet = await Wallet.findOne({ userId: req.session.sub })
        .select('_id pinHash failedPinAttempts lockedUntil').lean();
      if (pinWallet?.pinHash) {
        if (pinWallet.lockedUntil && pinWallet.lockedUntil > failedAt) {
          error.status = 429;
          error.message = 'Wallet security verification is temporarily locked. Please try again later.';
        } else {
          const nextFailureCount = { $add: [{ $ifNull: ['$failedPinAttempts', 0] }, 1] };
          const shouldLock = { $gte: [nextFailureCount, 5] };
          const failedAttempt = await Wallet.findOneAndUpdate(
            {
              _id: pinWallet._id,
              pinHash: pinWallet.pinHash,
              $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: failedAt } }],
            },
            [{
              $set: {
                failedPinAttempts: { $cond: [shouldLock, 0, nextFailureCount] },
                lockedUntil: { $cond: [shouldLock, new Date(failedAt.getTime() + 5 * 60 * 1000), '$lockedUntil'] },
              },
            }],
            { new: true },
          ).select('lockedUntil').lean();
          if (!failedAttempt || failedAttempt.lockedUntil > failedAt) {
            error.status = 429;
            error.message = 'Too many incorrect Wallet PIN attempts. Wallet payments are locked for 5 minutes.';
          }
        }
      }
    }
    const current = await WalletPaymentRequest.findOne({ requestId: req.params.requestId, status: 'Processing' }).select('requestId checkoutReference requesterUserId payerUserId expiresAt').lean();
    if (current) {
      const expired = current.expiresAt <= failedAt;
      const status = expired ? 'Expired' : error.status === 409 ? 'Cancelled' : 'Pending';
      await WalletPaymentRequest.updateOne(
        { requestId: current.requestId, status: 'Processing' },
        {
          $set: { status, paymentStatus: expired || status === 'Cancelled' || Boolean(error.status) ? 'FAILED' : 'PENDING' },
          ...(status === 'Pending' ? {} : { $unset: { activeCheckoutKey: 1 } }),
          $push: { statusHistory: { status: expired ? 'Payment Expired' : status === 'Cancelled' ? 'Payment Cancelled' : error.status ? 'Payment Failed' : 'Awaiting Payment', at: failedAt } },
        },
      );
      broadcastWalletPaymentRequestUpdate(current, {
        requestId: current.requestId,
        checkoutReference: current.checkoutReference,
        status,
        serverTime: failedAt.toISOString(),
      });
    }
    return res.status(error.status || 500).json({ message: error.message || 'Wallet ID payment could not be completed.' });
  }
});

app.get('/api/events', requireSession, requireDatabase, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const userId = String(req.session.sub);
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  const client = res;
  const userClients = sseUserClients.get(userId) || [];
  userClients.push(client);
  sseUserClients.set(userId, userClients);
  if (isAdmin) sseAdminClients.add(client);
  writeSseEvent(res, 'ready', { userId, isAdmin, serverTime: new Date().toISOString() });
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (error) { console.error('SSE heartbeat failed:', error.message); }
  }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const remaining = (sseUserClients.get(userId) || []).filter((entry) => entry !== client);
    if (remaining.length) sseUserClients.set(userId, remaining);
    else sseUserClients.delete(userId);
    sseAdminClients.delete(client);
  });
});

const encodeCheckoutQrPayload = ({ reference, totalPaise }) => {
  const body = {
    version: 1,
    company: 'Innovation Labs',
    reference,
    amountPaise: totalPaise,
    currency: 'INR',
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `ILPAY1.${encoded}.${signature}`;
};

const verifyCheckoutQrPayload = (payload) => {
  const parts = String(payload || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'ILPAY1') return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(parts[1]).digest('base64url');
  if (parts[2].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (body.version !== 1 || body.company !== 'Innovation Labs' || body.currency !== 'INR'
      || typeof body.reference !== 'string' || !Number.isSafeInteger(body.amountPaise) || body.amountPaise < 0) return null;
    return body;
  } catch {
    return null;
  }
};

const expireCheckoutAttemptIfNeeded = async (reference, userId) => {
  const now = new Date();
  return CheckoutAttempt.findOneAndUpdate(
    {
      reference,
      userId,
      status: { $in: ['Open', 'Payment Initiated'] },
      paymentStatus: 'Pending',
      expiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'Expired',
        paymentStatus: 'Failed',
        reason: 'Payment expired after four minutes without provider confirmation.',
        exitedAt: now,
      },
    },
    { new: true },
  );
};
const expireCheckoutAttempts = async () => {
  const now = new Date();
  await CheckoutAttempt.updateMany(
    {
      status: { $in: ['Open', 'Payment Initiated'] },
      paymentStatus: 'Pending',
      expiresAt: { $lte: now },
    },
    {
      $set: {
        status: 'Expired',
        paymentStatus: 'Failed',
        reason: 'Payment expired after four minutes without provider confirmation.',
        exitedAt: now,
      },
    },
  );
};
const checkoutExpirySweep = setInterval(() => {
  if (mongoose.connection.readyState === 1) {
    expireCheckoutAttempts().catch((error) => console.error('Checkout expiry sweep failed:', error.name));
  }
}, 10_000);
checkoutExpirySweep.unref();

app.get('/api/checkout/payment-qr', requireSession, requireDatabase, requireActiveExclusiveQrTransfer, async (req, res) => {
  const reference = typeof req.query.reference === 'string' ? req.query.reference.trim() : '';
  await expireCheckoutAttemptIfNeeded(reference, req.session.sub);
  const attempt = await CheckoutAttempt.findOne({
    reference,
    userId: req.session.sub,
    status: { $in: ['Open', 'Completing', 'Completed', 'Interrupted', 'Expired'] },
  }).select('reference totalPaise paymentStatus status expiresAt reason').lean();
  if (!attempt) return res.status(409).json({ message: 'This checkout is no longer active. Return to checkout and try again.' });
  const completedOrder = attempt.status === 'Completed'
    ? await Order.findOne({ checkoutReference: attempt.reference }).select('orderId').lean()
    : null;
  return res.json({
    qrPayload: encodeCheckoutQrPayload(attempt),
    company: 'Innovation Labs',
    checkoutReference: attempt.reference,
    amount: money(attempt.totalPaise),
    paymentStatus: attempt.paymentStatus,
    checkoutStatus: attempt.status,
    expiresAt: attempt.expiresAt,
    reason: attempt.reason,
    orderId: completedOrder?.orderId || null,
  });
});

app.post('/api/checkout/payment-qr/start', requireSession, requireDatabase, requireActiveExclusiveQrTransfer, async (req, res) => {
  const reference = typeof req.body?.checkoutReference === 'string' ? req.body.checkoutReference.trim() : '';
  await expireCheckoutAttemptIfNeeded(reference, req.session.sub);
  let attempt = await CheckoutAttempt.findOne({
    reference,
    userId: req.session.sub,
    status: { $in: ['Open', 'Payment Initiated'] },
  });
  if (attempt) {
    const deliveryRequired = orderRequiresDelivery(attempt.items);
    const requestedAddress = req.body?.address;
    const hasRequestedAddress = requestedAddress && typeof requestedAddress === 'object' && !Array.isArray(requestedAddress);
    if (deliveryRequired && hasRequestedAddress && !validateAddress(requestedAddress)) {
      return res.status(400).json({ message: 'Complete the required delivery address fields before starting payment.' });
    }
    if (deliveryRequired && !validateAddress(attempt.address)) {
      const savedUser = await User.findOne({ googleId: req.session.sub }).select('address').lean();
      const resolvedAddress = hasRequestedAddress ? requestedAddress : savedUser?.address;
      if (!validateAddress(resolvedAddress)) {
        return res.status(400).json({ message: 'Complete the required delivery address fields before starting payment.' });
      }
      attempt.address = resolvedAddress;
    } else if (deliveryRequired && hasRequestedAddress) {
      attempt.address = requestedAddress;
    }
    if (!attempt.expiresAt) {
      attempt.status = 'Open';
      attempt.stage = 'Payment Initiated';
      attempt.paymentStatus = 'Pending';
      attempt.expiresAt = new Date(Date.now() + 4 * 60 * 1000);
    }
    await attempt.save();
  }
  attempt = attempt?.toObject();
  if (!attempt) return res.status(409).json({ message: 'This checkout is no longer active. Return to checkout and try again.' });
  return res.json({
    qrPayload: encodeCheckoutQrPayload(attempt),
    company: 'Innovation Labs',
    checkoutReference: attempt.reference,
    amount: money(attempt.totalPaise),
    paymentStatus: attempt.paymentStatus,
    checkoutStatus: attempt.status,
    expiresAt: attempt.expiresAt,
  });
});

app.post('/api/checkout/payment-qr/expire', requireSession, requireDatabase, requireActiveExclusiveQrTransfer, async (req, res) => {
  const reference = typeof req.body?.checkoutReference === 'string' ? req.body.checkoutReference.trim() : '';
  const expired = await expireCheckoutAttemptIfNeeded(reference, req.session.sub);
  const attempt = expired || await CheckoutAttempt.findOne({ reference, userId: req.session.sub })
    .select('status paymentStatus expiresAt reason').lean();
  if (!attempt) return res.status(404).json({ message: 'This checkout payment session was not found.' });
  return res.json({ status: attempt.status, paymentStatus: attempt.paymentStatus, expiresAt: attempt.expiresAt, reason: attempt.reason });
});

app.post('/api/checkout/payment-qr/verify', requireSession, requireDatabase, requireActiveExclusiveQrTransfer, async (req, res) => {
  const payload = verifyCheckoutQrPayload(req.body?.qrPayload);
  if (!payload) return res.status(400).json({ message: 'This QR payment request is invalid or has been altered.' });
  const attempt = await CheckoutAttempt.findOne({
    reference: payload.reference,
    userId: req.session.sub,
    status: { $in: ['Open', 'Payment Initiated'] },
  }).select('reference totalPaise paymentStatus').lean();
  if (!attempt || attempt.totalPaise !== payload.amountPaise) {
    return res.status(409).json({ message: 'This QR payment request does not match the current checkout.' });
  }
  return res.json({
    verified: true,
    company: 'Innovation Labs',
    checkoutReference: attempt.reference,
    amount: money(attempt.totalPaise),
    paymentStatus: attempt.paymentStatus,
  });
});

app.post('/api/checkout/payment-qr/resolve', requireSession, requireDatabase, requireActiveExclusiveQrTransfer, async (req, res) => {
  const payload = verifyCheckoutQrPayload(req.body?.qrPayload);
  if (!payload) return res.status(400).json({ message: 'This QR payment request is invalid or has been altered.' });
  const attempt = await CheckoutAttempt.findOne({
    reference: payload.reference,
    status: { $in: ['Open', 'Payment Initiated'] },
    expiresAt: { $gt: new Date() },
  }).select('reference totalPaise paymentStatus expiresAt').lean();
  if (!attempt || attempt.totalPaise !== payload.amountPaise) {
    return res.status(409).json({ message: 'This QR payment request is expired or no longer available.' });
  }
  return res.json({
    company: 'Innovation Labs',
    checkoutReference: attempt.reference,
    amount: money(attempt.totalPaise),
    paymentStatus: attempt.paymentStatus,
    expiresAt: attempt.expiresAt,
  });
});

app.post('/api/checkout/payment-qr/pay', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const payload = verifyCheckoutQrPayload(req.body?.qrPayload);
  const pin = req.body?.pin;
  const idempotencyKey = req.body?.idempotencyKey;
  if (!payload || !validatePin(pin) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: 'A valid QR payment request and Wallet PIN are required.' });
  }
  const subscription = await currentSubscription(req.session.sub);
  if (subscription?.plan !== 'Exclusive') return res.status(403).json({ message: 'QR wallet payments are available to active Exclusive subscribers only.' });
  try {
    await CheckoutAttempt.updateOne(
      {
        reference: payload.reference,
        status: 'Open',
        paymentStatus: 'Pending',
        expiresAt: { $lte: new Date() },
      },
      {
        $set: {
          status: 'Interrupted',
          paymentStatus: 'Failed',
          reason: 'Payment expired after four minutes without provider confirmation.',
          exitedAt: new Date(),
        },
      },
    );
    const result = await withMongoTransaction(async (session) => {
      const attempt = await CheckoutAttempt.findOne({
        reference: payload.reference,
        status: { $in: ['Open', 'Payment Initiated'] },
        paymentStatus: 'Pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      if (!attempt || attempt.totalPaise !== payload.amountPaise) throw Object.assign(new Error('This QR payment request is expired or no longer available.'), { status: 409 });
      const referenceId = `checkout-qr:${attempt.reference}:${idempotencyKey}`;
      const duplicate = await WalletTransaction.findOne({ userId: req.session.sub, referenceId }).session(session).lean();
      if (duplicate) {
        const existingOrder = await Order.findOne({ checkoutReference: attempt.reference }).session(session).lean();
        if (!existingOrder) throw Object.assign(new Error('This QR payment was already processed but its order is unavailable.'), { status: 409 });
        return { order: existingOrder, wallet: await Wallet.findOne({ userId: req.session.sub }).session(session).lean(), checkoutOwnerId: attempt.userId, checkoutReference: attempt.reference, duplicate: true };
      }
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet?.pinHash) throw Object.assign(new Error('Create a Wallet PIN before paying from your Wallet.'), { status: 409 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet security verification is temporarily locked.'), { status: 429 });
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      const limitState = await getWalletLimitStatus(req.session.sub, wallet.balancePaise, session);
      const spendCheck = enforceAvailableWalletSpendLimit(wallet.balancePaise, attempt.totalPaise, limitState, 'Wallet balance');
      if (!spendCheck.allowed || wallet.balancePaise < attempt.totalPaise) {
        throw Object.assign(new Error(spendCheck.message || 'Insufficient wallet balance.'), { status: 402 });
      }
      const owner = await User.findOne({ googleId: attempt.userId }).session(session).lean();
      if (!owner) throw Object.assign(new Error('The checkout account could not be found.'), { status: 409 });
      const items = (attempt.items || []).map((item) => ({
        ...item,
        price: Number(item.unitPricePaise || 0) / 100,
        quantity: Number(item.quantity || 0),
      }));
      const { safeItems } = await resolveOrderItems(items, attempt.userId);
      const deliveryRequired = orderRequiresDelivery(safeItems);
      if (deliveryRequired && !validateAddress(attempt.address)) {
        throw Object.assign(new Error('The checkout delivery address is missing or incomplete. Please return to checkout and try again.'), { status: 409 });
      }
      const checkoutData = calculateOrder(safeItems, attempt.service);
      const calculatedBase = checkoutData.totalPaise;
      if (attempt.totalPaise > calculatedBase || attempt.totalPaise < 0) throw Object.assign(new Error('The checkout amount no longer matches the order.'), { status: 409 });
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems, { validateProductSnapshot: true });
      const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const before = wallet.balancePaise;
      wallet.balancePaise -= attempt.totalPaise;
      await wallet.save({ session });
      const [order] = await Order.create([{
        orderId,
        orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: attempt.userId,
        userName: owner.name || owner.email?.split('@')[0] || 'Innovation Labs customer',
        userEmail: owner.email || attempt.customerEmail,
        items: orderItemsSnapshot(safeItems),
        address: deliveryRequired ? attempt.address : null,
        deliveryRequired,
        service: attempt.service,
        projectDescription: '',
        subtotal: money(checkoutData.subtotalPaise),
        discountAmountPaise: Math.max(0, calculatedBase - attempt.totalPaise),
        codingCharge: money(checkoutData.codingChargePaise),
        buildingCharge: money(checkoutData.buildingChargePaise),
        deliveryCharge: money(checkoutData.deliveryChargePaise),
        total: money(attempt.totalPaise),
        paymentStatus: 'Paid',
        paymentMethod: 'Wallet QR',
        verifiedAmountPaidPaise: attempt.totalPaise,
        paymentVerifiedAt: new Date(),
        originalPaymentReference: referenceId,
        walletBalanceAfterPaise: wallet.balancePaise,
        inventoryDeductedAt,
        orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Paid from an Innovation Labs Wallet QR request', createdAt: new Date() }],
        checkoutReference: attempt.reference,
      }], { session });
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -attempt.totalPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        orderId,
        description: `QR checkout payment for ${orderId}`,
        status: 'Successful',
      }], { session });
      await createInvoiceForOrder(session, order);
      await Notification.create([{ userId: attempt.userId, message: `Order ${orderId} was paid from an Innovation Labs Wallet QR.` }], { session });
      attempt.status = 'Completed';
      attempt.paymentStatus = 'Paid';
      attempt.paymentReference = referenceId;
      attempt.completedAt = new Date();
      await attempt.save({ session });
      const cartItems = await removeOrderedItemsFromCart(session, attempt.userId, order.items);
      return { order: order.toObject(), wallet: wallet.toObject(), cartItems, checkoutOwnerId: attempt.userId, checkoutReference: attempt.reference, duplicate: false };
    });
    broadcastSse('cart_updated', { items: result.cartItems || [] }, result.checkoutOwnerId);
    broadcastOrderEvent(result.order, 'payment_success', { amount: result.order.total, payerUserId: req.session.sub });
    broadcastOrderEvent(result.order, 'order_created', { amount: result.order.total, payerUserId: req.session.sub });
    broadcastSse('checkout_payment_completed', {
      checkoutReference: result.checkoutReference,
      orderId: result.order.orderId,
      amount: result.order.total,
      payerUserId: req.session.sub,
    }, result.checkoutOwnerId);
    broadcastSse('wallet_balance_updated', { userId: req.session.sub, balance: money(result.wallet.balancePaise) }, req.session.sub);
    return res.status(result.duplicate ? 200 : 201).json({ order: result.order, wallet: walletView(result.wallet), duplicate: result.duplicate });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || 'QR wallet payment could not be completed.' });
  }
});

app.get('/api/wallet', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const walletRecord = await syncWalletRestrictionState(req.session.sub);
  const planState = await getWalletLimitStatus(req.session.sub, walletRecord?.balancePaise || 0);
  if (!walletRecord?.pinHash) return res.json({ setupRequired: true, wallet: null });
  const transactions = await WalletTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean();
  const walletData = walletView(walletRecord, transactions, planState);
  return res.json({ setupRequired: false, wallet: walletData, walletLimit: { plan: planState.plan, maximumBalance: money(planState.maximumBalancePaise), availableDepositCapacity: money(planState.availableDepositCapacityPaise) } });
});

app.get('/api/wallet/transfers/account', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('walletId').lean();
  if (!wallet) return res.status(409).json({ message: 'Create and unlock your wallet before transferring money.' });
  return res.json({ walletId: wallet.walletId || null });
});

app.get('/api/wallet/transfers/qr/access', requireSession, requireDatabase, async (req, res) => {
  const subscription = await currentSubscription(req.session.sub);
  return res.json({ available: subscription?.plan === 'Exclusive' });
});

app.post('/api/wallet/transfers/wallet-id', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const owner = await Wallet.findOne({ userId: req.session.sub }).select('_id walletId').lean();
  if (!owner) return res.status(409).json({ message: 'Create and unlock your wallet before creating a Wallet ID.' });
  if (owner.walletId) return res.json({ walletId: owner.walletId, existing: true });

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const letters = Array.from(crypto.randomBytes(4), (value) => alphabet[value % alphabet.length]).join('');
    const digits = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const walletId = `@WL${letters}${digits}`;
    try {
      const wallet = await Wallet.findOneAndUpdate(
        { _id: owner._id, walletId: null },
        { $set: { walletId } },
        { new: true, runValidators: true },
      ).select('walletId').lean();
      if (wallet) return res.status(201).json({ walletId: wallet.walletId, existing: false });
      const existing = await Wallet.findOne({ userId: req.session.sub }).select('walletId').lean();
      if (existing?.walletId) return res.json({ walletId: existing.walletId, existing: true });
      return res.status(409).json({ message: 'Your wallet is not available. Please try again.' });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  return res.status(503).json({ message: 'A unique Wallet ID could not be generated. Please try again.' });
});

app.post('/api/wallet/transfers/qr', requireSession, requireDatabase, requireWalletUnlock, requireActiveExclusiveQrTransfer, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('_id walletId +qrReference').lean();
  if (!wallet) return res.status(409).json({ message: 'Create and unlock your wallet before generating a QR code.' });
  let walletId = wallet.walletId;
  if (!walletId) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 5 && !walletId; attempt += 1) {
      const letters = Array.from(crypto.randomBytes(4), (value) => alphabet[value % alphabet.length]).join('');
      const digits = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      try {
        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: wallet._id, walletId: null },
          { $set: { walletId: `@WL${letters}${digits}` } },
          { new: true, runValidators: true },
        ).select('walletId +qrReference').lean();
        walletId = updatedWallet?.walletId
          || (await Wallet.findById(wallet._id).select('walletId +qrReference').lean())?.walletId
          || '';
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
  }
  if (!walletId) return res.status(503).json({ message: 'A unique Wallet ID could not be prepared. Please try again.' });

  let qrReference = wallet.qrReference;
  for (let attempt = 0; !qrReference && attempt < 3; attempt += 1) {
    try {
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id, $or: [{ qrReference: { $exists: false } }, { qrReference: null }] },
        { $set: { qrReference: crypto.randomBytes(32).toString('hex') } },
        { new: true, runValidators: true },
      ).select('walletId +qrReference').lean();
      if (updatedWallet?.qrReference) {
        qrReference = updatedWallet.qrReference;
        break;
      }
      const existingWallet = await Wallet.findById(wallet._id).select('walletId +qrReference').lean();
      qrReference = existingWallet?.qrReference;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  if (!qrReference) return res.status(503).json({ message: 'Your wallet QR could not be prepared. Please try again.' });
  const owner = await User.findOne({ googleId: req.session.sub }).select('name').lean();
  if (!owner) return res.status(404).json({ message: 'Your account could not be found.' });
  return res.json({
    walletId,
    fullName: safeRecipientName(owner.name),
    qrPayload: `ILW1:${qrReference}`,
  });
});

app.post('/api/wallet/transfers/qr/resolve', requireSession, requireDatabase, requireWalletUnlock, requireActiveExclusiveQrTransfer, async (req, res) => {
  const qrPayload = typeof req.body?.qrPayload === 'string' ? req.body.qrPayload.trim() : '';
  const match = /^ILW1:([a-f0-9]{64})$/.exec(qrPayload);
  if (!match) return res.status(400).json({ message: 'This is not a valid Innovation Labs wallet QR code.' });
  const recipientWallet = await Wallet.findOne({ qrReference: match[1] }).select('userId walletId').lean();
  if (!recipientWallet?.walletId) return res.status(404).json({ message: 'This wallet QR code is invalid or inactive.' });
  if (recipientWallet.userId === req.session.sub) return res.status(400).json({ message: 'You cannot transfer money to your own wallet.' });
  const recipient = await User.findOne({ googleId: recipientWallet.userId }).select('name picture accountStatus ageVerificationStatus').lean();
  if (!recipient || recipient.accountStatus === 'restricted' || recipient.ageVerificationStatus === 'restricted') {
    return res.status(404).json({ message: 'This wallet QR code is invalid or inactive.' });
  }
  return res.json({
    recipient: {
      walletId: recipientWallet.walletId,
      username: recipientWallet.walletId,
      displayName: safeRecipientName(recipient.name),
      profilePicture: recipient.picture || null,
    },
  });
});

app.post('/api/wallet/transfers/recipient', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const walletId = normalizeWalletId(req.body?.walletId);
  if (!validateWalletId(walletId)) return res.status(400).json({ message: 'Enter a valid Wallet ID in @WL plus 4 letters and 4 numbers format.' });
  const recipientWallet = await Wallet.findOne({ walletId }).select('userId').lean();
  if (!recipientWallet) return res.status(404).json({ message: 'Wallet ID not found. Please check the Wallet ID and try again.' });
  if (recipientWallet.userId === req.session.sub) return res.status(400).json({ message: 'You cannot transfer money to your own Wallet ID.' });
  const recipient = await User.findOne({ googleId: recipientWallet.userId }).select('name accountStatus ageVerificationStatus').lean();
  if (!recipient || recipient.accountStatus === 'restricted' || recipient.ageVerificationStatus === 'restricted') return res.status(404).json({ message: 'The account for this Wallet ID could not be found.' });
  return res.json({ recipient: { walletId, displayName: safeRecipientName(recipient?.name) } });
});

app.post('/api/wallet/transfers/quote', requireSession, requireDatabase, requireWalletUnlock, requireExclusiveQrTransferWhenUsed, async (req, res) => {
  const recipientWalletId = normalizeWalletId(req.body?.recipientWalletId);
  const amountPaise = Number(req.body?.amountPaise);
  const qrPayload = typeof req.body?.qrPayload === 'string' ? req.body.qrPayload.trim() : '';
  const qrMatch = qrPayload ? /^ILW1:([a-f0-9]{64})$/.exec(qrPayload) : null;
  if (!validateWalletId(recipientWalletId)) return res.status(400).json({ message: 'Enter a valid recipient Wallet ID.' });
  if (qrPayload && !qrMatch) return res.status(400).json({ message: 'This is not a valid Innovation Labs wallet QR code.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return res.status(400).json({ message: 'Enter a valid transfer amount greater than ₹0.' });
  const [sender, receiver] = await Promise.all([
    Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean(),
    Wallet.findOne({ walletId: recipientWalletId }).select('userId balancePaise +qrReference').lean(),
  ]);
  if (!sender) return res.status(409).json({ message: 'Your wallet is not available.' });
  const planLimit = await getWalletLimitStatus(req.session.sub, sender.balancePaise);
  if (!receiver) return res.status(404).json({ message: 'Wallet ID not found. Please check the Wallet ID and try again.' });
  if (qrMatch && receiver.qrReference !== qrMatch[1]) return res.status(409).json({ message: 'The scanned QR code does not match this recipient wallet.' });
  if (receiver.userId === req.session.sub) return res.status(400).json({ message: 'You cannot transfer money to your own Wallet ID.' });
  if (sender.balancePaise > planLimit.maximumBalancePaise) {
    return res.status(409).json({ message: 'Wallet transfers are unavailable while your balance exceeds your active plan limit.', maximumBalance: money(planLimit.maximumBalancePaise), availableBalance: money(planLimit.availableBalancePaise), restrictedBalance: money(planLimit.amountAboveLimitPaise) });
  }
  const recipientLimit = await getWalletLimitStatus(receiver.userId, receiver.balancePaise);
  if (receiver.balancePaise + amountPaise > recipientLimit.maximumBalancePaise) {
    return res.status(409).json({ message: 'This transfer would exceed the recipient wallet plan limit.', maximumBalance: money(recipientLimit.maximumBalancePaise) });
  }
  if (amountPaise > planLimit.availableBalancePaise) {
    return res.status(402).json({ message: `Insufficient Wallet Balance. Your available balance is ${money(planLimit.availableBalancePaise).toFixed(2)}.`, availableBalance: money(planLimit.availableBalancePaise) });
  }
  return res.json({ availableBalance: money(planLimit.availableBalancePaise), balanceAfter: money(planLimit.availableBalancePaise - amountPaise) });
});

app.post('/api/wallet/transfers/execute', requireSession, requireDatabase, requireWalletUnlock, requireExclusiveQrTransferWhenUsed, async (req, res) => {
  const recipientWalletId = normalizeWalletId(req.body?.recipientWalletId);
  const amountPaise = Number(req.body?.amountPaise);
  const pin = req.body?.pin;
  const qrPayload = typeof req.body?.qrPayload === 'string' ? req.body.qrPayload.trim() : '';
  const remarks = typeof req.body?.remarks === 'string'
    ? req.body.remarks.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
    : '';
  const qrMatch = qrPayload ? /^ILW1:([a-f0-9]{64})$/.exec(qrPayload) : null;
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey
    : null;
  if (!validateWalletId(recipientWalletId)) return res.status(400).json({ message: 'Enter a valid recipient Wallet ID.' });
  if (qrPayload && !qrMatch) return res.status(400).json({ message: 'This is not a valid Innovation Labs wallet QR code.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return res.status(400).json({ message: 'Enter a valid transfer amount greater than ₹0.' });
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN.' });
  if (!idempotencyKey) return res.status(400).json({ message: 'A valid transfer request key is required.' });

  const previousTransfer = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).lean();
  if (previousTransfer) {
    if (previousTransfer.receiverWalletId !== recipientWalletId || previousTransfer.amountPaise !== amountPaise) {
      return res.status(409).json({ message: 'This transfer request key is already associated with a different transfer.' });
    }
    const senderWallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
    return res.json({
      transfer: {
        transferId: previousTransfer.transferId,
        recipientWalletId: previousTransfer.receiverWalletId,
        recipientName: previousTransfer.receiverName || '',
        amount: money(previousTransfer.amountPaise),
        status: previousTransfer.status,
        completedAt: previousTransfer.completedAt,
      },
      senderBalance: money(Math.max(0, Number(senderWallet?.balancePaise ?? previousTransfer.senderBalanceAfterPaise) - Number(senderWallet?.restrictedBalancePaise || 0))),
      duplicate: true,
    });
  }

  const senderUser = await User.findOne({ googleId: req.session.sub }).select('_id').lean();
  if (!senderUser) return res.status(404).json({ message: 'The sender account could not be found.' });
  const senderForPin = await Wallet.findOne({ userId: req.session.sub }).select('pinHash lockedUntil').lean();
  if (!senderForPin) return res.status(404).json({ message: 'Your Wallet could not be found.' });
  if (!senderForPin.pinHash) return res.status(409).json({ message: 'Create a Wallet PIN before transferring money.' });
  const now = new Date();
  if (senderForPin.lockedUntil && senderForPin.lockedUntil > now) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, senderForPin.pinHash)) {
    const failedWallet = await Wallet.findOneAndUpdate(
      { userId: req.session.sub, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $inc: { failedPinAttempts: 1 } },
      { new: true },
    ).select('failedPinAttempts').lean();
    if (!failedWallet) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
    if (failedWallet.failedPinAttempts >= 5) {
      await Wallet.updateOne({ userId: req.session.sub }, { $set: { failedPinAttempts: 0, lockedUntil: new Date(Date.now() + 5 * 60 * 1000) } });
      return res.status(429).json({ message: 'Too many incorrect PIN attempts. Wallet transfers are locked for 5 minutes.' });
    }
    return res.status(401).json({ message: 'Incorrect Wallet PIN. Please try again.' });
  }

  try {
    const result = await withMongoTransaction(async (session) => {
      const prior = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).session(session).lean();
      if (prior) {
        if (prior.receiverWalletId !== recipientWalletId || prior.amountPaise !== amountPaise) {
          throw Object.assign(new Error('This transfer request key is already associated with a different transfer.'), { status: 409 });
        }
        return { transfer: prior, duplicate: true };
      }
      const sender = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!sender) throw Object.assign(new Error('Your Wallet could not be found.'), { status: 404 });
      if (!sender.walletId || !sender.pinHash) throw Object.assign(new Error('Your wallet is not ready for transfers.'), { status: 409 });
      if (sender.lockedUntil && sender.lockedUntil > new Date()) throw Object.assign(new Error('Wallet security verification is temporarily locked.'), { status: 429 });
      if (!verifyPin(pin, sender.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      const senderAccount = await User.findOne({ googleId: sender.userId }).select('name accountStatus ageVerificationStatus').session(session).lean();
      if (!senderAccount || senderAccount.accountStatus === 'restricted' || senderAccount.ageVerificationStatus === 'restricted') {
        throw Object.assign(new Error('Your account is not eligible to transfer money.'), { status: 403 });
      }
      const receiver = await Wallet.findOne({ walletId: recipientWalletId }).select('+qrReference').session(session);
      if (!receiver) throw Object.assign(new Error('Wallet ID not found. Please check the Wallet ID and try again.'), { status: 404 });
      if (qrMatch && receiver.qrReference !== qrMatch[1]) {
        throw Object.assign(new Error('The scanned QR code does not match this recipient wallet.'), { status: 409 });
      }
      const receiverAccount = await User.findOne({ googleId: receiver.userId }).select('name accountStatus ageVerificationStatus').session(session).lean();
      if (!receiverAccount || receiverAccount.accountStatus === 'restricted' || receiverAccount.ageVerificationStatus === 'restricted') {
        throw Object.assign(new Error('The account for this Wallet ID could not be found or is inactive.'), { status: 404 });
      }
      if (receiver.userId === sender.userId) throw Object.assign(new Error('You cannot transfer money to your own Wallet ID.'), { status: 400 });
      const limitState = await getWalletLimitStatus(req.session.sub, sender.balancePaise, session);
      if (sender.balancePaise > limitState.maximumBalancePaise) {
        throw Object.assign(new Error('Wallet transfers are unavailable while your balance exceeds your active plan limit.'), { status: 409, maximumBalance: money(limitState.maximumBalancePaise), availableBalance: money(limitState.availableBalancePaise), restrictedBalance: money(limitState.amountAboveLimitPaise) });
      }
      const receiverLimit = await getWalletLimitStatus(receiver.userId, receiver.balancePaise, session);
      if (receiver.balancePaise + amountPaise > receiverLimit.maximumBalancePaise) {
        throw Object.assign(new Error('This transfer would exceed the recipient wallet plan limit.'), { status: 409, maximumBalance: money(receiverLimit.maximumBalancePaise) });
      }
      const spendCheck = enforceAvailableWalletSpendLimit(sender.balancePaise, amountPaise, limitState, 'Wallet balance');
      if (!spendCheck.allowed) {
        throw Object.assign(new Error(spendCheck.message), { status: 409, maximumBalance: money(limitState.maximumBalancePaise), availableBalance: money(spendCheck.availableBalancePaise), restrictedBalance: money(spendCheck.restrictedBalancePaise) });
      }
      if (sender.balancePaise < amountPaise) throw Object.assign(new Error(`Insufficient Wallet Balance. Your available balance is ${money(limitState.availableBalancePaise).toFixed(2)}.`), { status: 402, availableBalance: money(limitState.availableBalancePaise) });

      const transferId = `TR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const completedAt = new Date();
      const senderBefore = sender.balancePaise;
      const receiverBefore = receiver.balancePaise;
      sender.balancePaise -= amountPaise;
      receiver.balancePaise += amountPaise;
      sender.failedPinAttempts = 0;
      sender.lockedUntil = undefined;
      await sender.save({ session });
      await receiver.save({ session });
      const [transfer] = await WalletTransfer.create([{
        transferId,
        senderUserId: sender.userId,
        senderWalletId: sender.walletId,
        receiverUserId: receiver.userId,
        receiverWalletId: receiver.walletId,
        senderName: safeRecipientName(senderAccount.name),
        receiverName: safeRecipientName(receiverAccount.name),
        remarks,
        amountPaise,
        currency: 'INR',
        status: 'COMPLETED',
        idempotencyKey,
        senderBalanceAfterPaise: sender.balancePaise,
        receiverBalanceAfterPaise: receiver.balancePaise,
        completedAt,
      }], { session });
      const [senderTransaction, receiverTransaction] = await WalletTransaction.create([
        {
          userId: sender.userId,
          type: 'Money Sent',
          amountPaise: -amountPaise,
          balanceBeforePaise: senderBefore,
          balanceAfterPaise: sender.balancePaise,
          availableBalanceAfterPaise: sender.availableBalancePaise,
          referenceId: `transfer:${transferId}:sender`,
          transferId,
          peerWalletId: receiver.walletId,
          description: `Money sent to ${safeRecipientName(receiverAccount.name)} (${receiver.walletId}) · Transfer ${transferId}${remarks ? ` · Note: ${remarks}` : ''}`.slice(0, 300),
          status: 'Completed',
        },
        {
          userId: receiver.userId,
          type: 'Money Received',
          amountPaise,
          balanceBeforePaise: receiverBefore,
          balanceAfterPaise: receiver.balancePaise,
          referenceId: `transfer:${transferId}:receiver`,
          transferId,
          peerWalletId: sender.walletId,
          description: `Money received from ${safeRecipientName(senderAccount.name)} (${sender.walletId}) · Transfer ${transferId}${remarks ? ` · Note: ${remarks}` : ''}`.slice(0, 300),
          status: 'Completed',
        },
      ], { session, ordered: true });
      return { transfer, senderTransaction, duplicate: false };
    });
    const transfer = result.transfer.toObject ? result.transfer.toObject() : result.transfer;
    const senderWallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
    const senderBalance = Math.max(0, Number(senderWallet?.balancePaise ?? transfer.senderBalanceAfterPaise) - Number(senderWallet?.restrictedBalancePaise || 0));
    const senderTransaction = result.senderTransaction
      ? walletView(senderWallet || { balancePaise: transfer.senderBalanceAfterPaise }, [result.senderTransaction]).transactions[0]
      : null;
    return res.json({
      transfer: {
        transferId: transfer.transferId,
        recipientWalletId: transfer.receiverWalletId,
        recipientName: transfer.receiverName,
        amount: money(transfer.amountPaise),
        status: transfer.status,
        completedAt: transfer.completedAt,
      },
      senderBalance: money(senderBalance),
      senderTransaction,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, availableBalance: error.availableBalance });
    if (error.code === 11000) {
      const duplicate = await WalletTransfer.findOne({ senderUserId: req.session.sub, idempotencyKey }).lean();
      if (duplicate && duplicate.receiverWalletId === recipientWalletId && duplicate.amountPaise === amountPaise) {
        const senderWallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
        return res.json({
          transfer: {
            transferId: duplicate.transferId,
            recipientWalletId: duplicate.receiverWalletId,
            recipientName: duplicate.receiverName || '',
            amount: money(duplicate.amountPaise),
            status: duplicate.status,
            completedAt: duplicate.completedAt,
          },
          senderBalance: money(Math.max(0, Number(senderWallet?.balancePaise ?? duplicate.senderBalanceAfterPaise) - Number(senderWallet?.restrictedBalancePaise || 0))),
          duplicate: true,
        });
      }
      if (duplicate) return res.status(409).json({ message: 'This transfer request key is already associated with a different transfer.' });
    }
    throw error;
  }
});

app.get('/api/wallet/transfers/:transferId/receipt', requireSession, requireDatabase, async (req, res) => {
  const transfer = await WalletTransfer.findOne({
    transferId: req.params.transferId,
    senderUserId: req.session.sub,
    status: 'COMPLETED',
  }).lean();
  if (!transfer) return res.status(404).json({ message: 'The completed wallet transfer could not be found.' });
  const [sender, receiver, senderWallet, receiverWallet] = await Promise.all([
    User.findOne({ googleId: transfer.senderUserId }).select('name email').lean(),
    User.findOne({ googleId: transfer.receiverUserId }).select('name email').lean(),
    Wallet.findOne({ userId: transfer.senderUserId }).select('walletId').lean(),
    Wallet.findOne({ userId: transfer.receiverUserId }).select('walletId').lean(),
  ]);
  if (!sender || !receiver || !senderWallet?.walletId || !receiverWallet?.walletId) {
    return res.status(409).json({ message: 'The account details for this transfer are unavailable.' });
  }
  const pdf = await renderTransferReceiptPdf({
    transfer,
    sender,
    receiver,
    senderWalletId: senderWallet.walletId,
    receiverWalletId: receiverWallet.walletId,
  });
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="innovation-labs-transfer-${transfer.transferId}.pdf"`);
  return res.send(pdf);
});

app.post('/api/checkout/quote', requireSession, requireDatabase, async (req, res) => {
  const { items, service = 'parts', discountCode } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    return res.status(400).json({ message: 'The checkout estimate requires at least one valid cart item.' });
  }
  if (!['parts', 'coding', 'building', 'full'].includes(service)) {
    return res.status(400).json({ message: 'Choose a valid project service.' });
  }
  try {
    const { safeItems } = await resolveOrderItems(items, req.session.sub);
    const calculated = calculateOrder(safeItems, service);
    const discount = discountCode
      ? await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems })
      : null;
    const discountAmountPaise = discount?.discountAmountPaise || 0;
    const subscriptionDiscount = await subscriptionDiscountForAmount(
      req.session.sub,
      Math.max(0, calculated.totalPaise - discountAmountPaise),
    );
    return res.json({
      items: safeItems.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unitPrice: money(toPaise(item.price)),
        lineTotal: money(toPaise(item.price) * item.quantity),
      })),
      subtotal: money(calculated.subtotalPaise),
      deliveryCharge: money(calculated.deliveryChargePaise),
      codingCharge: money(calculated.codingChargePaise),
      buildingCharge: money(calculated.buildingChargePaise),
      discount: money(discountAmountPaise),
      discountCode: discount?.code || null,
      subscriptionDiscount: money(subscriptionDiscount.amountPaise),
      subscriptionDiscountPlan: subscriptionDiscount.plan,
      subscriptionDiscountPercent: subscriptionDiscount.percentage,
      total: money(Math.max(0, calculated.totalPaise - discountAmountPaise - subscriptionDiscount.amountPaise)),
    });
  } catch (error) {
    return res.status(error.status || 400).json({
      message: error.message || 'Unable to calculate the current checkout estimate.',
    });
  }
});

app.post('/api/wallet/quote', requireSession, requireDatabase, async (req, res) => {
  const { items, service = 'parts', discountCode, payerWalletId } = req.body || {};
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  if (payerWalletId) return res.status(400).json({ message: 'Wallet ID owners are checked only when they approve a payment request.' });
  try {
    const { safeItems } = await resolveOrderItems(items, req.session.sub);
    const calculated = calculateOrder(safeItems, service);
    const discount = discountCode ? await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems }) : null;
    const discountAmountPaise = discount?.discountAmountPaise || 0;
    const subscriptionDiscount = await subscriptionDiscountForAmount(
      req.session.sub,
      Math.max(0, calculated.totalPaise - discountAmountPaise),
    );
    const totalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise - subscriptionDiscount.amountPaise);
    const wallet = await syncWalletRestrictionState(req.session.sub);
    if (!wallet) return res.status(409).json({ message: 'Create your wallet PIN before paying with Wallet.' });
    const walletState = await getWalletBalanceState(req.session.sub);
    const limitState = await getWalletLimitStatus(wallet.userId, walletState.balancePaise);
    return res.json({
      balance: limitState.availableBalance,
      availableBalance: limitState.availableBalance,
      restrictedBalance: money(limitState.restrictedBalancePaise),
      subtotal: money(calculated.subtotalPaise),
      discount: money(discountAmountPaise),
      discountCode: discount?.code || null,
      subscriptionDiscount: money(subscriptionDiscount.amountPaise),
      subscriptionDiscountPlan: subscriptionDiscount.plan,
      subscriptionDiscountPercent: subscriptionDiscount.percentage,
      delivery: money(calculated.deliveryChargePaise),
      codingCharge: money(calculated.codingChargePaise),
      buildingCharge: money(calculated.buildingChargePaise),
      total: money(totalPaise),
    });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'Unable to check wallet balance or calculate this order.' });
  }
});

app.get('/api/admin/promo-codes', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const promoCodes = await PromoCode.find().sort({ createdAt: -1 }).lean();
  return res.json({ promoCodes: promoCodes.map((promo) => ({ ...promo, amount: money(promo.amountPaise) })) });
});

app.get('/api/admin/rewards', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const rule = await RewardRule.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default', ...defaultRewardRules } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const [earned, redeemed, reversed] = await Promise.all(['earned', 'redeemed', 'reversed'].map((transactionType) =>
    RewardTransaction.aggregate([
      { $match: { transactionType } },
      { $group: { _id: null, points: { $sum: '$points' }, count: { $sum: 1 } } },
    ]).then((result) => result[0] || { points: 0, count: 0 }),
  ));
  let filter = {};
  let matchedUserIds = [];
  if (query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingUsers = await User.find({ $or: [{ email: new RegExp(escaped, 'i') }, { googleId: new RegExp(escaped, 'i') }] }).select('googleId').lean();
    matchedUserIds = matchingUsers.map((user) => user.googleId);
    filter = { $or: [
      { userId: new RegExp(escaped, 'i') },
      { userEmail: new RegExp(escaped, 'i') },
      { orderId: new RegExp(escaped, 'i') },
      ...(matchedUserIds.length ? [{ userId: { $in: matchedUserIds } }] : []),
    ] };
  }
  const transactions = await RewardTransaction.find(filter).sort({ createdAt: -1 }).limit(query ? 300 : 150).lean();
  const userIds = [...new Set([...transactions.map((transaction) => transaction.userId), ...matchedUserIds])];
  const accounts = await RewardAccount.find(query ? { userId: { $in: userIds } } : {}).sort({ updatedAt: -1 }).limit(300).lean();
  const users = await User.find({ googleId: { $in: accounts.map((account) => account.userId) } }).select('googleId email name').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({
    totals: {
      issuedPoints: earned.points,
      redeemedPoints: redeemed.points,
      reversedPoints: reversed.points,
      transactionCount: earned.count + redeemed.count + reversed.count,
    },
    rules: {
      minimumEligibleAmount: money(rule.minimumEligibleAmountPaise),
      firstTierMaximum: money(rule.firstTierMaximumPaise),
      firstTierPoints: rule.firstTierPoints,
      higherTierPoints: rule.higherTierPoints,
    },
    transactions: transactions.map((transaction) => ({ ...transaction, customer: usersById.get(transaction.userId) || null })),
    accounts: accounts.map((account) => ({ ...account, customer: usersById.get(account.userId) || null })),
  });
});

app.put('/api/admin/rewards/rules', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const minimumAmount = Number(req.body?.minimumEligibleAmount);
  const firstTierMaximum = Number(req.body?.firstTierMaximum);
  const firstTierPoints = Number(req.body?.firstTierPoints);
  const higherTierPoints = Number(req.body?.higherTierPoints);
  if (!Number.isFinite(minimumAmount) || minimumAmount < 0 || !Number.isFinite(firstTierMaximum) || firstTierMaximum <= minimumAmount ||
    !Number.isSafeInteger(firstTierPoints) || firstTierPoints < 0 || firstTierPoints > 1000000 ||
    !Number.isSafeInteger(higherTierPoints) || higherTierPoints < 0 || higherTierPoints > 1000000) {
    return res.status(400).json({ message: 'Enter valid minimum, tier limit, and whole-number reward values.' });
  }
  const rule = await RewardRule.findOneAndUpdate(
    { key: 'default' },
    { $set: {
      minimumEligibleAmountPaise: toPaise(minimumAmount),
      firstTierMaximumPaise: toPaise(firstTierMaximum),
      firstTierPoints,
      higherTierPoints,
      updatedBy: req.session.email,
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();
  return res.json({ rules: {
    minimumEligibleAmount: money(rule.minimumEligibleAmountPaise),
    firstTierMaximum: money(rule.firstTierMaximumPaise),
    firstTierPoints: rule.firstTierPoints,
    higherTierPoints: rule.higherTierPoints,
  } });
});

app.get('/api/admin/discount-offers', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry, PurchasedDiscountCode]);
    const [offers, purchases] = await Promise.all([
      DiscountCodeOffer.find().sort({ createdAt: -1 }).lean(),
      PurchasedDiscountCode.find({ isScratchReward: false }).sort({ purchasedAt: -1 }).limit(500).lean(),
    ]);
    const userIds = [...new Set(purchases.flatMap((purchase) => [purchase.purchaserUserId, purchase.userId]))];
    const users = await User.find({ googleId: { $in: userIds } }).select('googleId name email').lean();
    const usersById = new Map(users.map((user) => [user.googleId, user]));
    const orders = await Order.find({ orderId: { $in: purchases.map((purchase) => purchase.orderId) } }).select('orderId orderStatus paymentStatus').lean();
    const ordersById = new Map(orders.map((order) => [order.orderId, order]));
    return res.json({
      offers: offers.map((offer) => ({ ...discountOfferView(offer), code: offer.code, active: offer.active, purchasedCount: offer.purchasedCount, redeemedCount: offer.redeemedCount, maxRedemptions: offer.maxRedemptions, maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer, discountValuePaise: offer.discountValuePaise, discountPercent: offer.discountPercent, minimumPurchase: money(offer.minimumPurchasePaise), startsAt: offer.startsAt, expiresAt: offer.expiresAt })),
      purchases: purchases.map((purchase) => ({ ...purchase, purchaser: usersById.get(purchase.purchaserUserId) || null, recipient: usersById.get(purchase.userId) || null, order: ordersById.get(purchase.orderId) || null })),
    });
  } catch (error) {
    console.error('[discount-offers-list]', error.name, error.code || '', error.message);
    return res.status(503).json({ message: 'Discount offers could not be loaded from the database. Please retry.' });
  }
});

app.post('/api/admin/discount-offers/generate-code', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  try {
    return res.json({ code: await generateUniqueDiscountCode(null) });
  } catch (error) {
    console.error('[discount-code-generate]', error.name, error.code || '');
    return res.status(error.status || 503).json({ message: 'A unique discount promo code could not be generated. Please retry.' });
  }
});

const standardDiscountDenominations = [1, ...Array.from({ length: 10 }, (_, index) => (index + 1) * 100), ...Array.from({ length: 9 }, (_, index) => (index + 2) * 1000)];

app.post('/api/admin/discount-offers/generate-standard', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const generateNewCodes = req.body?.generateNewCodes === true;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const createdOfferIds = [];
  const createdCodes = [];
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry]);
    const created = [];
    const skipped = [];
    for (const denomination of standardDiscountDenominations) {
      const amountPaise = toPaise(denomination);
      const offerName = `₹${denomination.toLocaleString('en-IN')} Discount Promo Code`;
      if (!generateNewCodes) {
        const existing = await DiscountCodeOffer.findOne({
          name: offerName,
          active: true,
          discountType: 'fixed',
          sellingPricePaise: amountPaise,
          discountValuePaise: amountPaise,
        }).lean();
        if (existing) {
          skipped.push(denomination);
          continue;
        }
      }
      const code = await generateUniqueDiscountCode(null);
      const offer = await DiscountCodeOffer.create({
        code,
        name: offerName,
        source: 'AI_GENERATED',
        sellingPricePaise: amountPaise,
        discountType: 'fixed',
        discountValuePaise: amountPaise,
        discountPercent: 0,
        startsAt: now,
        expiresAt,
        maxRedemptions: 100000,
        maxRedemptionsPerCustomer: 1,
        availableQuantity: 1,
        minimumPurchasePaise: 0,
        eligibilityType: 'all',
        active: true,
      });
      createdOfferIds.push(offer._id);
      createdCodes.push(code);
      await DiscountCodeRegistry.create({ code, sourceType: 'offer', sourceId: String(offer._id) });
      created.push({ denomination, code, offerId: String(offer._id) });
    }
    return res.status(201).json({
      created,
      skipped,
      denominations: standardDiscountDenominations,
    });
  } catch (error) {
    if (createdOfferIds.length) {
      await Promise.all([
        DiscountCodeOffer.deleteMany({ _id: { $in: createdOfferIds } }),
        DiscountCodeRegistry.deleteMany({ code: { $in: createdCodes } }),
      ]).catch((rollbackError) => {
        console.error('[discount-standard-generation-rollback]', rollbackError.name, rollbackError.code || '', rollbackError.message);
      });
    }
    if (error.code === 11000) return res.status(409).json({ message: 'A generated code already exists. Retry to generate a different unique code.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: 'A standard discount offer failed validation. No generated offers were committed.' });
    }
    console.error('[discount-standard-generation]', error.name, error.code || '', error.message, classifyDatabaseError(error));
    return res.status(503).json({ message: 'MongoDB could not complete standard offer generation. Any offers created by this attempt were rolled back; please retry.' });
  }
});

app.post('/api/admin/discount-offers', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.offerName ?? req.body?.name ?? '').trim();
  const sellingPricePaise = toPaise(req.body?.sellingPrice);
  const discountType = req.body?.discountType;
  const customerDiscountValuePaise = toPaise(req.body?.customerDiscountValue ?? req.body?.discountValue);
  const discountPercent = Number(req.body?.discountPercent);
  const startsAt = new Date(req.body?.startsAt);
  const expiresAt = new Date(req.body?.expiresAt);
  const maxRedemptions = Number(req.body?.maxRedemptions);
  const maxRedemptionsPerCustomer = Number(req.body?.maxRedemptionsPerCustomer);
  const availableQuantity = Number(req.body?.availableQuantity);
  const minimumPurchasePaise = toPaise(req.body?.minimumPurchase || 0);
  const eligibilityType = req.body?.eligibilityType;
  const active = req.body?.active;
  const eligibleCategories = [...new Set((Array.isArray(req.body?.eligibleCategories) ? req.body.eligibleCategories : []).map((value) => String(value).trim()).filter(Boolean))];
  const eligibleProductIds = [...new Set((Array.isArray(req.body?.eligibleProductIds) ? req.body.eligibleProductIds : []).map((value) => String(value).trim()).filter(Boolean))];
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code) || !name || name.length > 100 || !Number.isSafeInteger(sellingPricePaise) || sellingPricePaise < 0 ||
    !['fixed', 'percentage'].includes(discountType) || !Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1 ||
    !Number.isSafeInteger(maxRedemptionsPerCustomer) || maxRedemptionsPerCustomer < 1 || maxRedemptionsPerCustomer > maxRedemptions ||
    !Number.isSafeInteger(availableQuantity) || availableQuantity < 1 || !Number.isSafeInteger(minimumPurchasePaise) || minimumPurchasePaise < 0 ||
    !['all', 'categories', 'products'].includes(eligibilityType) ||
    typeof active !== 'boolean' ||
    (eligibilityType === 'categories' && !eligibleCategories.length) ||
    (eligibilityType === 'products' && !eligibleProductIds.length) ||
    Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt <= startsAt ||
    (discountType === 'fixed' && (!Number.isSafeInteger(customerDiscountValuePaise) || customerDiscountValuePaise < 1)) ||
    (discountType === 'percentage' && (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100))) {
    return res.status(400).json({ message: 'Enter a unique code in XXXX-XXXX-XXXX-XXXX format and valid offer, eligibility, dates, and redemption limits.' });
  }
  if (eligibilityType === 'categories') {
    const existingCategories = new Set([...catalogPrices.values()].map((product) => product[1]));
    (await InventoryItem.distinct('category')).filter(Boolean).forEach((category) => existingCategories.add(category));
    if (eligibleCategories.some((category) => !existingCategories.has(category))) return res.status(400).json({ message: 'Choose eligible product categories from the catalog.' });
  }
  if (eligibilityType === 'products') {
    const existingProductIds = new Set([...catalogPrices.keys(), ...await InventoryItem.distinct('productId')]);
    if (eligibleProductIds.some((productId) => !existingProductIds.has(productId))) return res.status(400).json({ message: 'Choose eligible products from the catalog.' });
  }
  try {
    await ensureMongoCollections([DiscountCodeOffer, DiscountCodeRegistry]);
    const [existingPurchase, existingWalletCode] = await Promise.all([
      PurchasedDiscountCode.exists({ code }),
      PromoCode.exists({ code }),
    ]);
    if (existingPurchase || existingWalletCode || await DiscountCodeOffer.exists({ code }) || await DiscountCodeRegistry.exists({ code })) {
      return res.status(409).json({ message: 'A Discount Promo Code with that code already exists.' });
    }
    const offer = await DiscountCodeOffer.create({
      code,
      name,
      source: 'ADMIN',
      sellingPricePaise,
      discountType,
      discountValuePaise: discountType === 'fixed' ? customerDiscountValuePaise : 0,
      discountPercent: discountType === 'percentage' ? discountPercent : 0,
      startsAt,
      expiresAt,
      maxRedemptions,
      maxRedemptionsPerCustomer,
      availableQuantity,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories: eligibilityType === 'categories' ? eligibleCategories : [],
      eligibleProductIds: eligibilityType === 'products' ? eligibleProductIds : [],
      active,
    });
    try {
      await DiscountCodeRegistry.create({ code, sourceType: 'offer', sourceId: String(offer._id) });
    } catch (registryError) {
      await DiscountCodeOffer.deleteOne({ _id: offer._id });
      throw registryError;
    }
    return res.status(201).json({ offer: { ...discountOfferView(offer.toObject()), code, active, purchasedCount: 0, redeemedCount: 0 } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'A Discount Promo Code with that code already exists.' });
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ message: 'Discount offer fields are invalid. Check the values and dates, then retry.' });
    }
    const databaseErrorType = classifyDatabaseError(error);
    console.error('[discount-offer-create]', error.name, error.code || '', error.message, databaseErrorType);
    return res.status(databaseErrorType !== 'unknown' ? 503 : 500).json({
      message: databaseErrorType !== 'unknown'
        ? 'MongoDB could not complete the discount offer save. Check the database connection and retry.'
        : 'The discount offer could not be saved. Please retry.',
    });
  }
});

app.patch('/api/admin/discount-offers/:id/status', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Discount offer was not found.' });
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ message: 'Choose whether the offer is active.' });
  const offer = await DiscountCodeOffer.findByIdAndUpdate(req.params.id, { $set: { active: req.body.active } }, { new: true }).lean();
  if (!offer) return res.status(404).json({ message: 'Discount offer was not found.' });
  return res.json({ offer: { ...discountOfferView(offer), code: offer.code, active: offer.active, purchasedCount: offer.purchasedCount, redeemedCount: offer.redeemedCount, maxRedemptions: offer.maxRedemptions, maxRedemptionsPerCustomer: offer.maxRedemptionsPerCustomer } });
});

app.get('/api/admin/scratch-cards', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const settings = await ScratchSettings.findOneAndUpdate(
    { key: 'default' },
    { $setOnInsert: { key: 'default' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  const cards = await ScratchCard.find().sort({ createdAt: -1 }).limit(500).lean();
  const purchases = await PurchasedDiscountCode.find({ purchaseId: { $in: cards.map((card) => card.discountPurchaseId) } }).lean();
  const purchasesById = new Map(purchases.map((purchase) => [purchase.purchaseId, purchase]));
  const users = await User.find({ googleId: { $in: cards.map((card) => card.userId) } }).select('googleId name email').lean();
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  return res.json({
    settings: {
      enabled: settings.enabled,
      threshold: money(settings.thresholdPaise),
      rewardValues: settings.rewardValuesPaise.map(money),
      discountType: settings.discountType || 'fixed',
      minimumPurchase: money(settings.minimumPurchasePaise || 0),
      eligibilityType: settings.eligibilityType || 'all',
      eligibleCategories: settings.eligibleCategories || [],
      eligibleProductIds: settings.eligibleProductIds || [],
      expiryDays: settings.expiryDays,
      maxRedemptions: settings.maxRedemptions,
      transferable: settings.transferable,
    },
    scratchCards: cards.map((card) => ({ ...card, eligibleOrderAmount: money(card.eligibleOrderAmountPaise), rewardValue: money(card.rewardValuePaise), rewardType: card.rewardType || 'fixed', customer: usersById.get(card.userId) || null, rewardCode: purchasesById.get(card.discountPurchaseId)?.code || null })),
  });
});

app.put('/api/admin/scratch-cards/settings', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const enabled = req.body?.enabled;
  const thresholdPaise = toPaise(req.body?.threshold);
  const rewardValuesPaise = Array.isArray(req.body?.rewardValues) ? req.body.rewardValues.map(toPaise) : [];
  const discountType = req.body?.discountType;
  const minimumPurchasePaise = toPaise(req.body?.minimumPurchase);
  const eligibilityType = req.body?.eligibilityType;
  const eligibleCategories = [...new Set((Array.isArray(req.body?.eligibleCategories) ? req.body.eligibleCategories : []).map((value) => String(value).trim()).filter(Boolean))];
  const eligibleProductIds = [...new Set((Array.isArray(req.body?.eligibleProductIds) ? req.body.eligibleProductIds : []).map((value) => String(value).trim()).filter(Boolean))];
  const expiryDays = Number(req.body?.expiryDays);
  const maxRedemptions = Number(req.body?.maxRedemptions);
  const transferable = req.body?.transferable;
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(thresholdPaise) || thresholdPaise < 0 || !rewardValuesPaise.length ||
    rewardValuesPaise.length > 20 || rewardValuesPaise.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !['fixed', 'percentage'].includes(discountType) ||
    (discountType === 'percentage' && rewardValuesPaise.some((value) => value > 10000)) ||
    !Number.isSafeInteger(minimumPurchasePaise) || minimumPurchasePaise < 0 ||
    !['all', 'categories', 'products'].includes(eligibilityType) ||
    (eligibilityType === 'categories' && !eligibleCategories.length) ||
    (eligibilityType === 'products' && !eligibleProductIds.length) ||
    !Number.isSafeInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650 || !Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1 ||
    typeof transferable !== 'boolean') return res.status(400).json({ message: 'Enter valid scratch-card settings and positive reward values.' });
  if (eligibilityType === 'categories') {
    const existingCategories = new Set([...catalogPrices.values()].map((product) => product[1]));
    (await InventoryItem.distinct('category')).filter(Boolean).forEach((category) => existingCategories.add(category));
    if (eligibleCategories.some((category) => !existingCategories.has(category))) return res.status(400).json({ message: 'Choose eligible product categories from the catalog.' });
  }
  if (eligibilityType === 'products') {
    const existingProductIds = new Set([...catalogPrices.keys(), ...await InventoryItem.distinct('productId')]);
    if (eligibleProductIds.some((productId) => !existingProductIds.has(productId))) return res.status(400).json({ message: 'Choose eligible products from the catalog.' });
  }
  const settings = await ScratchSettings.findOneAndUpdate(
    { key: 'default' },
    { $set: {
      enabled,
      thresholdPaise,
      rewardValuesPaise,
      discountType,
      minimumPurchasePaise,
      eligibilityType,
      eligibleCategories: eligibilityType === 'categories' ? eligibleCategories : [],
      eligibleProductIds: eligibilityType === 'products' ? eligibleProductIds : [],
      expiryDays,
      maxRedemptions,
      transferable,
      updatedBy: req.session.email,
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();
  return res.json({ settings: {
    enabled: settings.enabled,
    threshold: money(settings.thresholdPaise),
    rewardValues: settings.rewardValuesPaise.map(money),
    discountType: settings.discountType,
    minimumPurchase: money(settings.minimumPurchasePaise),
    eligibilityType: settings.eligibilityType,
    eligibleCategories: settings.eligibleCategories,
    eligibleProductIds: settings.eligibleProductIds,
    expiryDays: settings.expiryDays,
    maxRedemptions: settings.maxRedemptions,
    transferable: settings.transferable,
  } });
});

app.get('/api/admin/invoices', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const filter = query ? { $or: [
    { invoiceNumber: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { orderId: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { customerEmail: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { customerName: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    { userId: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
  ] } : {};
  const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).limit(300).select('-pdfData').lean();
  const creditNotes = await CreditNote.find({ ...(query ? { $or: [filter.$or[1], filter.$or[2]] } : {}) }).sort({ createdAt: -1 }).limit(300).lean();
  return res.json({ invoices, creditNotes });
});

app.get('/api/admin/invoices/:invoiceId/download', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const invoice = await Invoice.findOne({ $or: [{ invoiceId: req.params.invoiceId }, { invoiceNumber: req.params.invoiceId }, { orderId: req.params.invoiceId }] }).select('+pdfData');
  if (!invoice?.pdfData) return res.status(404).json({ message: 'Invoice PDF was not found.' });
  if (!Buffer.isBuffer(invoice.pdfData) || invoice.pdfData.length < 5 || invoice.pdfData.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(500).json({ message: 'The stored invoice PDF is invalid.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  return res.send(invoice.pdfData);
});

app.get('/api/admin/subscriptions/finished', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  await processSubscriptionLifecycle();
  const now = new Date();
  const transactions = await SubscriptionTransaction.find({
    status: 'Successful',
    $or: [{ expiryDate: { $lte: now } }, { expiryDate: { $exists: false } }],
  }).sort({ createdAt: -1, expiryDate: -1 }).lean();
  const userIds = [...new Set(transactions.map((transaction) => transaction.userId))];
  const subscriptionIds = [...new Set(transactions.map((transaction) => transaction.subscriptionId).filter(Boolean).map(String))];
  const [users, linkedSubscriptions] = await Promise.all([
    User.find({ googleId: { $in: userIds } }).select('googleId name email').lean(),
    Subscription.find({ _id: { $in: subscriptionIds } }).select('paymentReference expiryDate').lean(),
  ]);
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  const subscriptionsById = new Map(linkedSubscriptions.map((subscription) => [String(subscription._id), subscription]));
  const search = String(req.query.search || '').trim().toLocaleLowerCase();
  const records = transactions.map((transaction) => {
    const user = usersById.get(transaction.userId);
    const linkedSubscription = transaction.subscriptionId
      ? subscriptionsById.get(String(transaction.subscriptionId))
      : null;
    const startDate = transaction.startDate || transaction.createdAt;
    const expiryDate = transaction.expiryDate
      || (linkedSubscription?.paymentReference === transaction.paymentReference ? linkedSubscription.expiryDate : null)
      || addMonths(startDate, transaction.durationMonths || 1);
    if (expiryDate > now) return null;
    return {
      id: String(transaction._id),
      orderId: transaction.orderId || `SUB-${transaction.paymentReference}`,
      userId: transaction.userId,
      customerName: user?.name || 'Unknown customer',
      customerEmail: user?.email || '',
      plan: transaction.plan,
      purchaseDate: transaction.createdAt,
      startDate,
      expiryDate,
      durationMonths: transaction.durationMonths || 1,
      monthlyPricePaise: transaction.monthlyPricePaise ?? planConfig[transaction.plan]?.pricePaise ?? 0,
      amountPaise: transaction.amountPaise,
      paymentMethod: transaction.paymentMethod,
      status: 'Expired',
    };
  }).filter((record) => record && (!search
    || `${record.customerName} ${record.customerEmail} ${record.plan}`.toLocaleLowerCase().includes(search)));
  return res.json({ subscriptions: records, serverNow: now.toISOString() });
});

const adminSubscriptionOrderRecords = async () => {
  const missingCategory = { $or: [{ orderCategory: { $exists: false } }, { orderCategory: null }] };
  await Promise.all([
    SubscriptionTransaction.updateMany(missingCategory, { $set: { orderCategory: 'SUBSCRIPTION_ORDER' } }),
    AIBillPurchase.updateMany(missingCategory, { $set: { orderCategory: 'SUBSCRIPTION_ORDER' } }),
    CreditPurchase.updateMany(missingCategory, { $set: { orderCategory: 'SUBSCRIPTION_ORDER' } }),
  ]);
  const [subscriptionTransactions, billPurchases, creditPurchases] = await Promise.all([
    SubscriptionTransaction.find({ status: 'Successful', orderCategory: 'SUBSCRIPTION_ORDER' }).sort({ createdAt: 1 }).lean(),
    AIBillPurchase.find({ status: 'completed', orderCategory: 'SUBSCRIPTION_ORDER' }).sort({ createdAt: 1 }).lean(),
    CreditPurchase.find({ status: 'completed', orderCategory: 'SUBSCRIPTION_ORDER' }).sort({ createdAt: 1 }).lean(),
  ]);
  const userIds = [...new Set([
    ...subscriptionTransactions.map((transaction) => transaction.userId),
    ...billPurchases.map((purchase) => purchase.userId),
    ...creditPurchases.map((purchase) => purchase.userId),
  ])];
  const subscriptionIds = [...new Set(subscriptionTransactions.map((transaction) => transaction.subscriptionId).filter(Boolean).map(String))];
  const [users, linkedSubscriptions] = await Promise.all([
    User.find({ googleId: { $in: userIds } }).select('googleId name email').lean(),
    Subscription.find({ _id: { $in: subscriptionIds } }).select('plan status expiryDate paymentReference').lean(),
  ]);
  const usersById = new Map(users.map((user) => [user.googleId, user]));
  const subscriptionsById = new Map(linkedSubscriptions.map((subscription) => [String(subscription._id), subscription]));
  const now = new Date();
  const seenSubscriptions = new Set();
  const subscriptionOrders = subscriptionTransactions.map((transaction) => {
    const user = usersById.get(transaction.userId);
    const subscriptionId = transaction.subscriptionId ? String(transaction.subscriptionId) : '';
    const linkedSubscription = transaction.subscriptionId
      ? subscriptionsById.get(subscriptionId)
      : null;
    const purchaseDate = transaction.createdAt;
    const startDate = transaction.startDate || purchaseDate;
    const expiryDate = transaction.expiryDate
      || (linkedSubscription?.paymentReference === transaction.paymentReference ? linkedSubscription.expiryDate : null)
      || addMonths(startDate, transaction.durationMonths || 1);
    const inferredRenewal = Boolean(subscriptionId && seenSubscriptions.has(subscriptionId));
    if (subscriptionId) seenSubscriptions.add(subscriptionId);
    const transactionType = transaction.transactionType
      || (inferredRenewal ? 'renewal' : 'purchase');
    return {
      id: String(transaction._id),
      orderId: transaction.orderId || `SUB-${transaction.paymentReference}`,
      orderCategory: 'SUBSCRIPTION_ORDER',
      transactionType,
      customerName: user?.name || 'Unknown customer',
      customerEmail: user?.email || '',
      plan: transaction.plan,
      durationMonths: transaction.durationMonths || 1,
      creditsAllocated: Number.isSafeInteger(transaction.creditsAllocated)
        ? transaction.creditsAllocated
        : (planConfig[transaction.plan]?.credits || 0) * (transaction.durationMonths || 1),
      billsAllocated: Number.isSafeInteger(transaction.billsAllocated)
        ? transaction.billsAllocated
        : getAiMonthlyAllowanceForPlan(transaction.plan) * (transaction.durationMonths || 1),
      purchaseDate,
      startDate,
      expiryDate,
      monthlyPricePaise: transaction.monthlyPricePaise ?? planConfig[transaction.plan]?.pricePaise ?? 0,
      amountPaise: transaction.amountPaise,
      paymentMethod: transaction.paymentMethod,
      paymentStatus: 'Successful',
      paymentReference: transaction.paymentReference,
      subscriptionStatus: linkedSubscription?.status === 'active' && linkedSubscription.expiryDate > now
        ? 'Active'
        : expiryDate > now && (!linkedSubscription || linkedSubscription.paymentReference === transaction.paymentReference)
          ? 'Active'
          : 'Expired',
    };
  });
  const addOnOrders = [
    ...billPurchases.map((purchase) => {
      const user = usersById.get(purchase.userId);
      return {
        id: purchase.purchaseId,
        orderId: `BILL-${purchase.purchaseId}`,
        orderCategory: 'SUBSCRIPTION_ORDER',
        transactionType: 'bill_purchase',
        subscriptionName: 'AI Bill Credits',
        customerName: user?.name || 'Unknown customer',
        customerEmail: user?.email || '',
        plan: purchase.subscriptionDiscountPlan || 'Starter',
        quantity: purchase.quantity,
        creditsDeducted: purchase.creditsDeducted || 0,
        amountPaise: purchase.totalAmountPaise,
        paymentMethod: purchase.paymentMethod,
        paymentStatus: 'Successful',
        paymentReference: purchase.paymentReference,
        subscriptionStatus: 'Completed',
        purchaseDate: purchase.createdAt,
      };
    }),
    ...creditPurchases.map((purchase) => {
      const user = usersById.get(purchase.userId);
      return {
        id: purchase.purchaseId,
        orderId: `CREDIT-${purchase.purchaseId}`,
        orderCategory: 'SUBSCRIPTION_ORDER',
        transactionType: 'credit_purchase',
        subscriptionName: 'AI Credits',
        customerName: user?.name || 'Unknown customer',
        customerEmail: user?.email || '',
        plan: purchase.authorizedPlan || 'Exclusive',
        creditsAllocated: purchase.credits,
        amountPaise: purchase.totalAmountPaise,
        paymentMethod: purchase.paymentMethod,
        paymentStatus: 'Successful',
        paymentReference: purchase.razorpayPaymentId || purchase.walletTransactionId || purchase.purchaseId,
        subscriptionStatus: 'Completed',
        purchaseDate: purchase.completedAt || purchase.createdAt,
      };
    }),
  ];
  return [...subscriptionOrders, ...addOnOrders]
    .sort((left, right) => new Date(right.purchaseDate || 0) - new Date(left.purchaseDate || 0));
};

app.get('/api/admin/part-orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  await Order.updateMany(
    { $or: [{ orderCategory: { $exists: false } }, { orderCategory: null }] },
    { $set: { orderCategory: 'PART_ORDER' } },
  );
  const orders = await Order.find({ orderCategory: 'PART_ORDER' }).sort({ createdAt: -1 }).lean();
  return res.json({ orders: await adminOrdersView(orders) });
});

app.get('/api/admin/subscription-orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  return res.json({ subscriptionOrders: await adminSubscriptionOrderRecords() });
});

app.get('/api/admin/orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  await Order.updateMany(
    { $or: [{ orderCategory: { $exists: false } }, { orderCategory: null }] },
    { $set: { orderCategory: 'PART_ORDER' } },
  );
  const [orders, subscriptionOrders] = await Promise.all([
    Order.find({ orderCategory: 'PART_ORDER' }).sort({ createdAt: -1 }).lean(),
    adminSubscriptionOrderRecords(),
  ]);
  return res.json({ subscriptionOrders, orders: await adminOrdersView(orders) });
});

app.get('/api/admin/orders/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  let order = null;
  if (mongoose.isValidObjectId(req.params.id)) {
    order = await Order.findById(req.params.id).lean();
  }
  if (!order) {
    order = await Order.findOne({ orderId: req.params.id }).lean();
  }
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  return res.json({ order: (await adminOrdersView([order]))[0] });
});

app.patch('/api/admin/orders/:id/accept', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Order was not found.' });
  const { estimatedDelivery } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  const deliveryDate = new Date(estimatedDelivery || Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(deliveryDate.getTime())) return res.status(400).json({ message: 'Enter a valid delivery date.' });

  try {
    const accepted = await withMongoTransaction(async (session) => {
      const current = await Order.findById(order._id).session(session);
      if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      const hasActiveItems = (current.items || []).some((item) =>
        Number(item.quantity || 0) > Number(item.cancelledQuantity || 0));
      const hasCancelledItems = (current.items || []).some((item) => Number(item.cancelledQuantity || 0) > 0);
      const isPartiallyCancelled = hasActiveItems && hasCancelledItems;
      if ((current.orderStatus === 'Cancelled' || current.cancelledAt) && !isPartiallyCancelled) {
        throw Object.assign(new Error('A cancelled order cannot be accepted.'), { status: 409 });
      }
      if (current.orderStatus === 'Accepted') return current.toObject();
      if (!hasActiveItems) {
        throw Object.assign(new Error('An order with no remaining active products cannot be accepted.'), { status: 409 });
      }
      if (current.orderType === 'PROMO_CODE') {
        if (current.purchaseType !== 'offline' || current.orderStatus !== 'Pending Admin Approval' || current.paymentStatus !== 'Paid') {
          throw Object.assign(new Error('Only paid offline Promo Code orders awaiting approval can be accepted.'), { status: 409 });
        }
        const promo = await PromoCode.findOne({ _id: current.promoCodeId, orderId: current.orderId, status: 'pending_approval', purchaseType: 'offline' }).session(session);
        if (!promo) throw Object.assign(new Error('The reserved Promo Code is no longer available for fulfillment.'), { status: 409 });
        const activatedAt = new Date();
        activatePromoCode(promo, activatedAt);
        const recipientUserId = current.recipientType === 'gift' && current.recipientUserId ? current.recipientUserId : current.userId;
        const recipient = recipientUserId === current.userId
          ? null
          : await User.findOne({ googleId: recipientUserId }).select('googleId name email').session(session).lean();
        if (recipientUserId !== current.userId && (!recipient || recipient.email !== current.recipientEmail)) {
          throw Object.assign(new Error('The offline gift recipient could not be verified for fulfillment.'), { status: 409 });
        }
        promo.status = 'purchased';
        promo.purchasedBy = { userId: recipientUserId, name: recipient?.name || current.userName, email: recipient?.email || current.userEmail };
        promo.purchasedAt = new Date();
        await promo.save({ session });
        current.promoCode = promo.code;
        current.promoCodeStatus = 'PURCHASED';
        current.promoActivationStatus = 'active';
        current.promoActivatedAt = promo.activatedAt;
        current.promoExpiresAt = promo.expiresAt;
        current.promoMaxUses = promo.maxUses || 10;
        current.promoSuccessfulUses = promo.successfulUses || 0;
        current.recipientUserId = recipientUserId === current.userId ? undefined : recipientUserId;
        current.recipientEmail = recipient?.email || current.recipientEmail;
        current.orderStatus = 'Accepted';
        current.approvalStatus = 'accepted';
        current.acceptedAt = new Date();
        current.estimatedDelivery = deliveryDate;
        current.statusHistory = [...(current.statusHistory || []), { status: 'Accepted', note: 'Offline Promo Code order accepted by admin; Promo Code activated for the customer.', createdAt: new Date() }];
        await current.save({ session });
        await awardRewardPointsForOrder(session, current);
        const notifications = [{ userId: current.userId, message: `Your offline Promo Code order ${current.orderId} was accepted and fulfilled.` }];
        if (recipientUserId !== current.userId) notifications.push({
          userId: recipientUserId,
          type: 'promo_gift_received',
          data: { orderId: current.orderId, buyerName: current.userName, buyerEmail: current.userEmail, promoName: 'Digital Wallet Credit', amount: money(promo.amountPaise), receivedAt: activatedAt },
          message: `You received a Promo Code gift from ${current.userName}. It is ready in your Wallet.`,
        });
        await Notification.create(notifications, { session });
        return current.toObject();
      }
      if (!current.inventoryDeductedAt) {
        const remainingItems = (current.items || []).flatMap((item) => {
          const remainingQuantity = Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0));
          return remainingQuantity > 0 ? [{ ...item.toObject(), quantity: remainingQuantity }] : [];
        });
        if (remainingItems.length) {
          current.inventoryDeductedAt = await applyInventoryReduction(session, remainingItems);
        }
      }
      current.orderStatus = 'Accepted';
      if (isPartiallyCancelled) {
        current.cancelledAt = undefined;
        current.cancellationId = undefined;
        current.cancellationIdempotencyKey = undefined;
      }
      for (const item of current.items || []) {
        if (Number(item.cancelledQuantity || 0) >= Number(item.quantity || 0)) {
          item.fulfillmentStatus = 'Cancelled';
        } else if (!['Delivered', 'Completed'].includes(item.fulfillmentStatus)) {
          item.fulfillmentStatus = 'Accepted';
        }
      }
      current.acceptedAt = new Date();
      current.estimatedDelivery = deliveryDate;
      current.statusHistory = [...(current.statusHistory || []), { status: 'Accepted', note: 'Order accepted by admin', createdAt: new Date() }];
      await current.save({ session });
      await Notification.create([{ userId: current.userId, message: `Order ${current.orderId} has been accepted and is now being processed.` }], { session });
      return current.toObject();
    });
    broadcastOrderEvent(accepted, 'order_accepted', { acceptedAt: accepted.acceptedAt, estimatedDelivery: accepted.estimatedDelivery });
    return res.json({ order: accepted });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

const rejectOfflinePromoOrder = async ({ orderId, reason, adminEmail: declinedBy }) => withMongoTransaction(async (session) => {
  const current = await Order.findById(orderId).session(session);
  if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
  if (current.orderStatus === 'Rejected' && current.refundCaseId) {
    const existingRefund = await Refund.findOne({ refundCaseId: current.refundCaseId, orderId: current.orderId, userId: current.userId }).session(session);
    if (existingRefund?.status === 'REFUND_COMPLETED') {
      const wallet = await Wallet.findOne({ userId: current.userId }).session(session);
      return { order: current.toObject(), refund: existingRefund.toObject(), walletBalance: wallet ? walletAvailableBalancePaise(wallet) : null, duplicate: true };
    }
  }
  if (current.orderType !== 'PROMO_CODE' || current.purchaseType !== 'offline' || current.orderStatus !== 'Pending Admin Approval') {
    throw Object.assign(new Error('Only offline Promo Code orders awaiting approval can be rejected.'), { status: 409 });
  }
  if (current.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can be rejected and refunded.'), { status: 409 });
  const promo = await PromoCode.findOne({ _id: current.promoCodeId, orderId: current.orderId, status: 'pending_approval', purchaseType: 'offline' }).session(session);
  if (!promo) throw Object.assign(new Error('The reserved Promo Code for this order could not be verified.'), { status: 409 });
  const refundAmountPaise = toPaise(current.total);
  const itemAmountPaise = (current.items || []).reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  if (!Number.isSafeInteger(refundAmountPaise) || refundAmountPaise <= 0 || refundAmountPaise !== promo.amountPaise || itemAmountPaise !== refundAmountPaise || toPaise(current.subtotal) !== refundAmountPaise) {
    throw Object.assign(new Error('The saved Promo Code payment breakdown is invalid; no refund was issued.'), { status: 409 });
  }
  if (current.paymentMethod === 'Wallet') {
    const originalPayment = await WalletTransaction.findOne({ userId: current.userId, orderId: current.orderId, type: 'Purchase', amountPaise: -refundAmountPaise, status: 'Successful' }).session(session).lean();
    if (!originalPayment) throw Object.assign(new Error('The original Wallet payment could not be verified; no refund was issued.'), { status: 409 });
  } else if (current.paymentMethod !== 'Razorpay' || !current.razorpayId) {
    throw Object.assign(new Error('The original payment could not be verified; no refund was issued.'), { status: 409 });
  }
  const wallet = await Wallet.findOneAndUpdate(
    { userId: current.userId },
    { $setOnInsert: { userId: current.userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session },
  );
  const balanceBeforePaise = wallet.balancePaise;
  const balanceAfterPaise = balanceBeforePaise + refundAmountPaise;
  if (!Number.isSafeInteger(balanceAfterPaise)) throw Object.assign(new Error('The customer Wallet balance cannot accept this refund.'), { status: 409 });
  const now = new Date();
  const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const transactionReferenceId = `offline-promo-refund:${current.orderId}`;
  if (await WalletTransaction.exists({ referenceId: transactionReferenceId }).session(session)) {
    throw Object.assign(new Error('A refund transaction already exists for this order.'), { status: 409 });
  }
  wallet.balancePaise = balanceAfterPaise;
  await wallet.save({ session });
  const [transaction] = await WalletTransaction.create([{
    userId: current.userId,
    type: 'Refund',
    amountPaise: refundAmountPaise,
    balanceBeforePaise,
    balanceAfterPaise,
    referenceId: transactionReferenceId,
    orderId: current.orderId,
    refundCaseId,
    description: `Refund for rejected offline Promo Code order ${current.orderId}`,
    status: 'Completed',
  }], { session });
  const [refund] = await Refund.create([{
    refundCaseId,
    orderId: current.orderId,
    userId: current.userId,
    userName: current.userName,
    userEmail: current.userEmail,
    originalOrderAmountPaise: refundAmountPaise,
    calculatedRefundAmountPaise: refundAmountPaise,
    approvedRefundAmountPaise: refundAmountPaise,
    refundAmountPaise,
    itemsSnapshot: current.items,
    orderSnapshot: { createdAt: current.createdAt, total: money(refundAmountPaise), subtotal: money(refundAmountPaise), deliveryCharge: 0, paymentMethod: current.paymentMethod, paymentStatus: current.paymentStatus, purchaseType: 'offline' },
    reason: String(reason || 'Order rejected by admin.').trim().slice(0, 500),
    reasonCategory: 'Offline Promo Order Rejection',
    adminReason: String(reason || 'Order rejected by admin.').trim().slice(0, 500),
    walletTransactionId: transaction._id,
    walletTransactionReferenceId: transactionReferenceId,
    status: 'REFUND_COMPLETED',
    statusHistory: [{ status: 'REFUND_COMPLETED', changedBy: declinedBy, note: 'Offline Promo Code order rejected; payment amount credited to customer Wallet.', createdAt: now }],
    adminAudit: [{ adminId: declinedBy, action: 'offline_promo_order_rejected_refunded', timestamp: now, oldStatus: current.orderStatus, newStatus: 'Rejected', amountPaise: refundAmountPaise, reason: String(reason || 'Order rejected by admin.').trim().slice(0, 500) }],
  }], { session });
  await PromoCode.updateOne(
    { _id: promo._id, status: 'pending_approval', orderId: current.orderId },
    { $set: { status: 'unused' }, $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, purchaseIdempotencyKey: 1, razorpayOrderId: 1, razorpayPaymentId: 1, purchasedBy: 1, purchasedAt: 1, orderId: 1 } },
    { session },
  );
  current.orderStatus = 'Rejected';
  current.approvalStatus = 'rejected';
  current.promoCodeStatus = undefined;
  current.promoActivationStatus = 'rejected';
  current.refundCaseId = refundCaseId;
  current.refundAmountPaise = refundAmountPaise;
  current.refundTransactionReferenceId = transactionReferenceId;
  current.statusHistory = [...(current.statusHistory || []), { status: 'Rejected', note: `Rejected by admin. ₹${money(refundAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was credited to the customer Wallet.`, createdAt: now }];
  await current.save({ session });
  await createCreditNoteForRefund(session, { userId: current.userId, orderId: current.orderId, refundCaseId, amountPaise: refundAmountPaise, reason: 'Offline Promo Code order rejected.' });
  await Notification.create([{ userId: current.userId, message: `Your offline Promo Code order ${current.orderId} was rejected. ₹${money(refundAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was refunded to your Wallet.` }], { session });
  return { order: current.toObject(), refund: refund.toObject(), walletBalance: walletAvailableBalancePaise(wallet), duplicate: false };
});

app.patch('/api/admin/orders/:id/decline', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Order was not found.' });
  const { reason = '' } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  if (order.orderType === 'PROMO_CODE') {
    if (order.purchaseType !== 'offline') return res.status(409).json({ message: 'Online Promo Code orders are already confirmed and cannot be declined.' });
    try {
      const result = await rejectOfflinePromoOrder({ orderId: order._id, reason, adminEmail: req.session.email });
      return res.json({ order: result.order, refund: result.refund, wallet: result.walletBalance == null ? undefined : { balance: money(result.walletBalance) }, duplicate: result.duplicate });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      if (error.code === 11000) return res.status(409).json({ message: 'This offline Promo Code order has already been processed.' });
      throw error;
    }
  }
  try {
    let result = await withMongoTransaction(async (session) => {
      const current = await Order.findById(order._id).session(session);
      if (!current) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      const hasActiveItems = (current.items || []).some((item) =>
        Number(item.quantity || 0) > Number(item.cancelledQuantity || 0));
      const hasCancelledItems = (current.items || []).some((item) => Number(item.cancelledQuantity || 0) > 0);
      const isPartiallyCancelled = hasActiveItems && hasCancelledItems;
      if ((current.orderStatus === 'Cancelled' || current.cancelledAt) && !isPartiallyCancelled) {
        throw Object.assign(new Error('A cancelled order cannot be declined.'), { status: 409 });
      }
      if (current.orderStatus === 'Declined') {
        const existingRefund = await Refund.findOne({ orderId: current.orderId, userId: current.userId, reasonCategory: 'Order Decline' }).session(session);
        if (existingRefund && ['REFUND_COMPLETED', 'REFUND_PROCESSING'].includes(existingRefund.status)) {
          const wallet = await Wallet.findOne({ userId: current.userId }).session(session);
          return {
            order: current.toObject(),
            refund: existingRefund.toObject(),
            walletBalance: wallet ? walletAvailableBalancePaise(wallet) : null,
            duplicate: true,
            shouldProcessRazorpayRefund: existingRefund.refundDestination === 'Razorpay' && existingRefund.status === 'REFUND_PROCESSING',
            razorpayPaymentId: existingRefund.refundDestination === 'Razorpay' ? existingRefund.originalPaymentReference : null,
            idempotencyKey: existingRefund.refundIdempotencyKey,
            refundCaseId: existingRefund.refundCaseId,
          };
        }
        throw Object.assign(new Error('This order has already been declined. Its refund requires support reconciliation before another attempt.'), { status: 409 });
      }
      if (!hasActiveItems) {
        throw Object.assign(new Error('An order with no remaining active products cannot be declined.'), { status: 409 });
      }
      if (current.orderType === 'PROMO_CODE') throw Object.assign(new Error('Promo Code orders are not eligible for an order-decline refund.'), { status: 409 });
      if (current.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can receive an automatic decline refund.'), { status: 409 });
      if (!['Wallet', 'Razorpay'].includes(current.paymentMethod)) throw Object.assign(new Error('This order payment method is not eligible for an automatic decline refund.'), { status: 409 });
      if (current.refundCaseId) throw Object.assign(new Error('A refund case already exists for this order.'), { status: 409 });
      const otherRefundCase = await Refund.findOne({
        orderId: current.orderId,
        userId: current.userId,
        reasonCategory: { $ne: 'Order Decline' },
        status: { $ne: 'REFUND_REJECTED' },
      }).session(session).lean();
      if (otherRefundCase) throw Object.assign(new Error('A separate refund case already exists for this order; resolve it before declining the order.'), { status: 409 });
      const priorRefundTransaction = await WalletTransaction.findOne({
        userId: current.userId,
        orderId: current.orderId,
        type: { $in: ['Refund', 'Order Decline Refund', 'Cancellation Refund'] },
        cancellationSource: { $ne: 'CUSTOMER' },
        status: { $in: ['Successful', 'Completed'] },
      }).session(session).lean();
      if (priorRefundTransaction) throw Object.assign(new Error('A refund has already been credited for this order.'), { status: 409 });

      const customer = await User.findOne({ googleId: current.userId }).session(session).lean();
      if (!customer) throw Object.assign(new Error('The customer account for this order could not be found.'), { status: 404 });
      let wallet = null;
      if (current.paymentMethod === 'Wallet') {
        wallet = await Wallet.findOne({ userId: current.userId }).session(session);
        if (!wallet) throw Object.assign(new Error('The customer Wallet could not be found; the order was not declined.'), { status: 409 });
      }

      const partsAmountPaise = toPaise(current.subtotal);
      const codingChargePaise = toPaise(current.codingCharge || 0);
      const buildingChargePaise = toPaise(current.buildingCharge || 0);
      const deliveryChargePaise = toPaise(current.deliveryCharge || 0);
      const discountAmountPaise = Number(current.discountAmountPaise || 0);
      const totalPaidPaise = toPaise(current.total);
      let verifiedAmountPaidPaise = 0;
      let originalPaymentReference = '';
      const itemSnapshotAmountPaise = (current.items || []).reduce((sum, item) => {
        const itemPricePaise = toPaise(item.price);
        if (!Number.isSafeInteger(itemPricePaise) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) return NaN;
        return sum + itemPricePaise * item.quantity;
      }, 0);
      if (!Number.isSafeInteger(partsAmountPaise) || partsAmountPaise <= 0 ||
        !Number.isSafeInteger(codingChargePaise) || codingChargePaise < 0 ||
        !Number.isSafeInteger(buildingChargePaise) || buildingChargePaise < 0 ||
        !Number.isSafeInteger(deliveryChargePaise) || deliveryChargePaise < 0 ||
        !Number.isSafeInteger(discountAmountPaise) || discountAmountPaise < 0 ||
        !Number.isSafeInteger(totalPaidPaise) || totalPaidPaise <= 0 ||
        itemSnapshotAmountPaise !== partsAmountPaise ||
        partsAmountPaise + codingChargePaise + buildingChargePaise + deliveryChargePaise - discountAmountPaise !== totalPaidPaise) {
        throw Object.assign(new Error('The saved order payment breakdown is invalid; no refund or decline was recorded.'), { status: 409 });
      }
      if (current.paymentMethod === 'Wallet') {
        const originalPayment = await WalletTransaction.findOne({
          userId: current.userId,
          orderId: current.orderId,
          type: 'Purchase',
          amountPaise: -totalPaidPaise,
          status: 'Successful',
        }).session(session).lean();
        if (!originalPayment) throw Object.assign(new Error('The original Wallet payment could not be verified; no refund or decline was recorded.'), { status: 409 });
        verifiedAmountPaidPaise = Math.abs(originalPayment.amountPaise);
        originalPaymentReference = originalPayment.referenceId;
      } else {
        if (!current.razorpayId) throw Object.assign(new Error('The original Razorpay payment reference is missing; no refund or decline was recorded.'), { status: 409 });
        if (!razorpayKeyId || !razorpayKeySecret) throw Object.assign(new Error('Razorpay verification is unavailable; no refund or decline was recorded.'), { status: 503 });
        let paymentResponse;
        try {
          paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(current.razorpayId)}`, {
            headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
          });
        } catch {
          throw Object.assign(new Error('Razorpay could not verify the original payment right now. Nothing was refunded or declined.'), { status: 503 });
        }
        const payment = await paymentResponse.json();
        if (!paymentResponse.ok || payment.status !== 'captured' || payment.currency !== 'INR'
          || payment.amount !== totalPaidPaise || Number(payment.amount_refunded || 0) !== 0) {
          throw Object.assign(new Error('The original Razorpay payment is not a fully captured, unrefunded payment for this order.'), { status: 409 });
        }
        if (current.checkoutReference) {
          const checkout = await CheckoutAttempt.findOne({
            reference: current.checkoutReference,
            userId: current.userId,
            status: 'Completed',
            paymentReference: current.razorpayId,
            razorpayOrderId: payment.order_id,
            totalPaise: payment.amount,
          }).session(session).lean();
          if (!checkout) throw Object.assign(new Error('The original Razorpay payment could not be matched to the completed order checkout.'), { status: 409 });
        }
        verifiedAmountPaidPaise = payment.amount;
        originalPaymentReference = current.razorpayId;
      }
      if (!Number.isSafeInteger(verifiedAmountPaidPaise) || verifiedAmountPaidPaise <= 0 || verifiedAmountPaidPaise !== totalPaidPaise) {
        throw Object.assign(new Error('The verified payment amount does not match the saved order total; no refund was recorded.'), { status: 409 });
      }
      const now = new Date();
      const declineReason = String(reason || 'Order declined by admin.').trim().slice(0, 500);
      const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const paymentReferenceHash = crypto.createHash('sha256').update(originalPaymentReference).digest('hex').slice(0, 24);
      const transactionReferenceId = `order-decline-refund:${current.orderId}:${paymentReferenceHash}`;
      const refundDestination = current.paymentMethod === 'Wallet' ? 'Innovation Labs Wallet' : 'Razorpay';
      const priorCustomerRefundPaise = Number(current.cancellationRefundedPaise || 0);
      const refundAmountDuePaise = verifiedAmountPaidPaise - priorCustomerRefundPaise;
      if (!Number.isSafeInteger(refundAmountDuePaise) || refundAmountDuePaise <= 0) {
        throw Object.assign(new Error('No refundable balance remains for this order; no decline refund was recorded.'), { status: 409 });
      }
      const providerIdempotencyKey = crypto.createHash('sha256')
        .update(`admin-decline:${current.orderId}:${originalPaymentReference}`)
        .digest('hex').slice(0, 32);
      let transaction = null;
      let walletBalance = null;
      await restoreInventoryForOrder(session, current);
      if (refundDestination === 'Innovation Labs Wallet' && refundAmountDuePaise > 0) {
        const nextBalancePaise = wallet.balancePaise + refundAmountDuePaise;
        if (!Number.isSafeInteger(nextBalancePaise)) throw Object.assign(new Error('The customer Wallet balance cannot accept this refund.'), { status: 409 });
        const existingTransaction = await WalletTransaction.findOne({ referenceId: transactionReferenceId }).session(session);
        if (existingTransaction) throw Object.assign(new Error('An automatic decline refund transaction already exists for this order.'), { status: 409 });
        const priorDeclineTransaction = await WalletTransaction.findOne({
          orderId: current.orderId,
          type: 'Order Decline Refund',
        }).session(session);
        if (priorDeclineTransaction) throw Object.assign(new Error('A decline refund transaction already exists for this order.'), { status: 409 });
        const balanceBeforePaise = wallet.balancePaise;
        wallet.balancePaise = nextBalancePaise;
        await wallet.save({ session });
        [transaction] = await WalletTransaction.create([{
          userId: current.userId,
          type: 'Order Decline Refund',
          amountPaise: refundAmountDuePaise,
          balanceBeforePaise,
          balanceAfterPaise: wallet.balancePaise,
          referenceId: transactionReferenceId,
          orderId: current.orderId,
          refundCaseId,
          originalPaymentMethod: current.paymentMethod,
          originalPaymentReference,
          refundDestination,
          cancellationSource: 'ADMIN',
          description: `Full amount paid refunded to Innovation Labs Wallet for order ${current.orderId} declined by admin.`,
          status: 'Completed',
        }], { session });
        walletBalance = wallet.balancePaise;
      }
      if (refundDestination === 'Innovation Labs Wallet' && refundAmountDuePaise === 0) {
        walletBalance = wallet.balancePaise;
      }
      const statusHistory = [
        { status: 'ORDER_DECLINED', changedBy: req.session.email, note: declineReason, createdAt: now },
        {
          status: refundDestination === 'Innovation Labs Wallet' ? 'REFUND_COMPLETED' : 'REFUND_PROCESSING',
          changedBy: req.session.email,
          note: refundDestination === 'Innovation Labs Wallet'
            ? `₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} remaining paid amount credited to the customer's Innovation Labs Wallet.`
            : `₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} remaining paid amount submitted to Razorpay for refund.`,
          createdAt: now,
        },
      ];
      const [refund] = await Refund.create([{
        refundCaseId,
        orderId: current.orderId,
        userId: current.userId,
        userName: current.userName,
        userEmail: current.userEmail,
        originalPaymentMethod: current.paymentMethod,
        originalPaymentReference,
        verifiedAmountPaidPaise,
        refundDestination,
        cancellationSource: 'ADMIN',
        refundIdempotencyKey: refundDestination === 'Razorpay' ? providerIdempotencyKey : undefined,
        refundTransactionReferenceId: transactionReferenceId,
        refundCreatedAt: now,
        refundCompletedAt: refundDestination === 'Innovation Labs Wallet' ? now : undefined,
        originalOrderAmountPaise: verifiedAmountPaidPaise,
        calculatedRefundAmountPaise: refundAmountDuePaise,
        approvedRefundAmountPaise: refundAmountDuePaise,
        refundAmountPaise: refundAmountDuePaise,
        itemsSnapshot: (current.items || []).map(({ id, name, category, price, quantity }) => ({ id, name, category, price, quantity })),
        orderSnapshot: {
          createdAt: current.createdAt,
          total: money(totalPaidPaise),
          discountAmountPaise,
          subtotal: money(partsAmountPaise),
          codingCharge: money(codingChargePaise),
          buildingCharge: money(buildingChargePaise),
          deliveryCharge: money(deliveryChargePaise),
          paymentMethod: current.paymentMethod,
          paymentStatus: current.paymentStatus,
        },
        reason: declineReason,
        reasonCategory: 'Order Decline',
        adminReason: declineReason,
        walletTransactionId: transaction?._id,
        walletTransactionReferenceId: transaction ? transactionReferenceId : undefined,
        status: refundDestination === 'Innovation Labs Wallet' ? 'REFUND_COMPLETED' : 'REFUND_PROCESSING',
        statusHistory,
        adminAudit: [{ adminId: req.session.email, action: 'automatic_order_decline_refund', timestamp: now, oldStatus: current.orderStatus, newStatus: refundDestination === 'Innovation Labs Wallet' ? 'REFUND_COMPLETED' : 'REFUND_PROCESSING', amountPaise: refundAmountDuePaise, reason: declineReason }],
      }], { session });

      current.orderStatus = 'Declined';
      for (const item of current.items || []) {
        if (Number(item.cancelledQuantity || 0) >= Number(item.quantity || 0)) {
          item.fulfillmentStatus = 'Cancelled';
        } else if (!['Delivered', 'Completed'].includes(item.fulfillmentStatus)) {
          item.fulfillmentStatus = 'Declined';
        }
      }
      current.refundCaseId = refundCaseId;
      current.verifiedAmountPaidPaise = verifiedAmountPaidPaise;
      current.paymentVerifiedAt = now;
      current.originalPaymentReference = originalPaymentReference;
      current.refundAmountPaise = refundAmountDuePaise;
      current.refundTransactionReferenceId = transactionReferenceId;
      current.refundReason = declineReason;
      current.refundStatus = refundDestination === 'Innovation Labs Wallet' ? 'Completed' : 'Pending';
      current.refundDestination = refundDestination;
      current.refundCreatedAt = now;
      current.refundCompletedAt = refundDestination === 'Innovation Labs Wallet' ? now : undefined;
      current.cancellationSource = 'ADMIN';
      current.cancellationReason = declineReason;
      current.statusHistory = [...(current.statusHistory || []), {
        status: 'Declined',
        note: refundDestination === 'Innovation Labs Wallet'
          ? `${declineReason} ₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} remaining paid amount credited to Innovation Labs Wallet.`
          : `${declineReason} ₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} remaining paid amount submitted to Razorpay.`,
        createdAt: now,
      }];
      await current.save({ session });
      await reverseRewardPointsForOrder(session, current.toObject(), { referenceId: transactionReferenceId, refundAmountPaise: refundAmountDuePaise });
      await releaseDiscountRedemptionForOrder(session, current.orderId);
      if (refundAmountDuePaise > 0) {
        await createCreditNoteForRefund(session, { userId: current.userId, orderId: current.orderId, refundCaseId, amountPaise: refundAmountDuePaise, reason: declineReason });
      }
      await Notification.create([{
        userId: current.userId,
        message: refundDestination === 'Innovation Labs Wallet'
          ? `Your order ${current.orderId} was declined by the admin. ₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} has been credited to your Innovation Labs Wallet. Check Wallet History and My Orders for the refund.`
          : `Your order ${current.orderId} was declined by the admin. A remaining refund of ₹${money(refundAmountDuePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} is being processed to your original Razorpay payment method.`,
      }], { session });
      return {
        order: current.toObject(),
        refund: refund.toObject(),
        walletBalance,
        duplicate: false,
        shouldProcessRazorpayRefund: refundDestination === 'Razorpay',
        razorpayPaymentId: refundDestination === 'Razorpay' ? originalPaymentReference : null,
        idempotencyKey: refundDestination === 'Razorpay' ? providerIdempotencyKey : null,
        refundCaseId,
      };
    });
    if (result.shouldProcessRazorpayRefund) {
      try {
        const providerRefund = await refundRazorpayOrderPayment(
          result.razorpayPaymentId,
          Number(result.refund.refundAmountPaise),
          result.idempotencyKey,
          result.order.orderId,
          Number(result.refund.verifiedAmountPaidPaise || result.refund.originalOrderAmountPaise),
        );
        if (providerRefund.amountPaise !== Number(result.refund.refundAmountPaise)) {
          throw new Error('Razorpay returned a refund amount that does not match the approved refund amount.');
        }
        const nextRefundStatus = providerRefund.status === 'processed'
          ? 'REFUND_COMPLETED'
          : providerRefund.status === 'failed' ? 'REFUND_REJECTED' : 'REFUND_PROCESSING';
        result = await withMongoTransaction(async (session) => {
          const refund = await Refund.findOne({
            refundCaseId: result.refundCaseId,
            orderId: result.order.orderId,
            userId: result.order.userId,
            reasonCategory: 'Order Decline',
          }).session(session);
          const current = await Order.findById(result.order._id).session(session);
          if (!refund || !current) throw Object.assign(new Error('The saved refund record could not be found after Razorpay processing.'), { status: 500 });
          const previousStatus = refund.status;
          refund.refundProviderReference = providerRefund.refundId;
          refund.refundProviderStatus = providerRefund.status || 'pending';
          refund.status = nextRefundStatus;
          if (nextRefundStatus === 'REFUND_COMPLETED') refund.refundCompletedAt = new Date();
          refund.statusHistory.push({
            status: nextRefundStatus,
            changedBy: req.session.email,
            note: nextRefundStatus === 'REFUND_COMPLETED'
              ? `Razorpay completed the approved refund of ₹${money(providerRefund.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`
              : nextRefundStatus === 'REFUND_REJECTED'
                ? 'Razorpay reported that the refund failed. Support reconciliation is required.'
                : 'Razorpay accepted the approved refund request; provider processing is pending.',
            createdAt: new Date(),
          });
          refund.adminAudit.push({
            adminId: req.session.email,
            action: 'razorpay_order_decline_refund_update',
            timestamp: new Date(),
            oldStatus: previousStatus,
            newStatus: nextRefundStatus,
            amountPaise: providerRefund.amountPaise,
            reason: providerRefund.refundId,
          });
          await refund.save({ session });

          current.refundStatus = nextRefundStatus === 'REFUND_COMPLETED' ? 'Completed'
            : nextRefundStatus === 'REFUND_REJECTED' ? 'Failed' : 'Pending';
          current.refundCompletedAt = nextRefundStatus === 'REFUND_COMPLETED' ? refund.refundCompletedAt : undefined;
          current.statusHistory.push({
            status: nextRefundStatus,
            note: nextRefundStatus === 'REFUND_COMPLETED'
              ? `Razorpay completed the approved refund. Reference: ${providerRefund.refundId}.`
              : nextRefundStatus === 'REFUND_REJECTED'
                ? `Razorpay reported refund failure. Reference: ${providerRefund.refundId}.`
                : `Razorpay is processing the approved refund. Reference: ${providerRefund.refundId}.`,
            createdAt: new Date(),
          });
          await current.save({ session });
          if (previousStatus !== nextRefundStatus && nextRefundStatus === 'REFUND_COMPLETED') {
            await Notification.create([{
              userId: current.userId,
              message: `Razorpay completed the approved refund of ₹${money(providerRefund.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} for order ${current.orderId}.`,
            }], { session });
          }
          return {
            order: current.toObject(),
            refund: refund.toObject(),
            walletBalance: null,
            duplicate: result.duplicate,
            refundCaseId: result.refundCaseId,
          };
        });
        if (nextRefundStatus !== 'REFUND_COMPLETED') {
          return res.status(nextRefundStatus === 'REFUND_REJECTED' ? 502 : 202).json({
            message: nextRefundStatus === 'REFUND_REJECTED'
              ? 'The order was declined, but Razorpay reported a refund failure. Please contact support for reconciliation.'
              : 'The order was declined and the full Razorpay refund is still processing. Check My Orders for the latest status.',
            order: result.order,
            refund: result.refund,
            duplicate: result.duplicate,
          });
        }
      } catch (refundError) {
        console.error('Admin order-decline Razorpay refund is pending reconciliation:', refundError.message);
        return res.status(502).json({
          message: `The order was declined and its full Razorpay refund is pending confirmation. No completed refund is being reported. ${refundError.message}`,
          order: result.order,
          refund: result.refund,
          pending: true,
        });
      }
    }
    const refundCase = {
      _id: result.refund._id,
      refundCaseId: result.refund.refundCaseId,
      status: result.refund.status,
      refundAmountPaise: result.refund.refundAmountPaise,
      approvedRefundAmountPaise: result.refund.approvedRefundAmountPaise,
      reasonCategory: result.refund.reasonCategory,
      walletTransactionReferenceId: result.refund.walletTransactionReferenceId,
      refundTransactionReferenceId: result.refund.refundTransactionReferenceId,
      originalPaymentMethod: result.refund.originalPaymentMethod,
      originalPaymentReference: result.refund.originalPaymentReference,
      verifiedAmountPaidPaise: result.refund.verifiedAmountPaidPaise,
      refundDestination: result.refund.refundDestination,
      refundCreatedAt: result.refund.refundCreatedAt,
      refundCompletedAt: result.refund.refundCompletedAt,
    };
    broadcastOrderEvent(result.order, 'order_declined', {
      refundStatus: result.refund?.status || result.order.refundStatus || null,
      refundAmountPaise: result.refund?.refundAmountPaise || result.order.refundAmountPaise || null,
    });
    if (result.walletBalance != null) {
      broadcastSse('wallet_balance_updated', {
        userId: result.order.userId,
        balance: money(result.walletBalance),
        availableBalance: money(result.walletBalance),
      }, result.order.userId);
    }
    return res.json({
      order: { ...result.order, refundCase },
      refund: result.refund,
      wallet: result.walletBalance == null ? undefined : { balance: money(result.walletBalance) },
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const [current, refund] = await Promise.all([
        Order.findById(order._id).lean(),
        Refund.findOne({ orderId: order.orderId, userId: order.userId, reasonCategory: 'Order Decline' }).lean(),
      ]);
      if (current?.orderStatus === 'Declined' && refund?.status === 'REFUND_COMPLETED') {
        const wallet = await Wallet.findOne({ userId: order.userId }).select('balancePaise restrictedBalancePaise').lean();
        const refundCase = {
          _id: refund._id,
          refundCaseId: refund.refundCaseId,
          status: refund.status,
          refundAmountPaise: refund.refundAmountPaise,
          approvedRefundAmountPaise: refund.approvedRefundAmountPaise,
          reasonCategory: refund.reasonCategory,
          walletTransactionReferenceId: refund.walletTransactionReferenceId,
          refundTransactionReferenceId: refund.refundTransactionReferenceId,
          originalPaymentMethod: refund.originalPaymentMethod,
          originalPaymentReference: refund.originalPaymentReference,
          verifiedAmountPaidPaise: refund.verifiedAmountPaidPaise,
          refundDestination: refund.refundDestination,
          refundCreatedAt: refund.refundCreatedAt,
          refundCompletedAt: refund.refundCompletedAt,
        };
        return res.json({ order: { ...current, refundCase }, refund, wallet: wallet ? { balance: money(walletAvailableBalancePaise(wallet)) } : undefined, duplicate: true });
      }
      return res.status(409).json({ message: 'An automatic decline refund transaction already exists for this order.' });
    }
    throw error;
  }
});

app.get('/api/admin/inventory', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const inventory = await InventoryItem.find().sort({ name: 1 }).lean();
  return res.json({ inventory });
});

app.post('/api/admin/inventory', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const { productId, name, category = 'Other Components', pricePaise, description = '', stock = 0 } = req.body || {};
  const normalizedProductId = String(productId || '').trim();
  const normalizedName = String(name || '').trim();
  const normalizedCategory = String(category || 'Other Components').trim().slice(0, 80);
  const normalizedPrice = Number(pricePaise ?? 0);
  const normalizedStock = Number(stock);
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  const technicalSpecs = req.body?.technicalSpecs && typeof req.body.technicalSpecs === 'object' && !Array.isArray(req.body.technicalSpecs) ? req.body.technicalSpecs : {};
  const safeImages = images.map((value) => String(value).trim()).filter(Boolean);
  const safeTechnicalSpecs = Object.fromEntries(Object.entries(technicalSpecs).slice(0, 30).map(([key, value]) => [
    String(key).trim().slice(0, 80),
    String(value).trim().slice(0, 300),
  ]).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(key) && value));
  const stockInputValid = typeof stock === 'number' || typeof stock === 'string' && /^\d+$/.test(stock);
  if (!normalizedProductId || !normalizedName || !Number.isFinite(normalizedPrice) || normalizedPrice < 0 || !stockInputValid || !Number.isSafeInteger(normalizedStock) || normalizedStock < 0) {
    return res.status(400).json({ message: 'Provide a product ID, item name, valid price, and non-negative whole-number stock.' });
  }
  if (images.length > 8 || safeImages.length !== images.filter((value) => String(value).trim()).length || safeImages.some((image) => image.length > 2048 || !(image.startsWith('/') && !image.startsWith('//') || /^https?:\/\//i.test(image)))) {
    return res.status(400).json({ message: 'Provide up to 8 valid image URLs.' });
  }
  const previous = await InventoryItem.findOne({ productId: normalizedProductId }).select('stock').lean();
  const item = await InventoryItem.findOneAndUpdate(
    { productId: normalizedProductId },
    {
      $set: {
        productId: normalizedProductId,
        name: normalizedName,
        category: normalizedCategory || 'Other Components',
        pricePaise: Math.round(normalizedPrice),
        description: String(description).slice(0, 1000),
        images: safeImages,
        technicalSpecs: safeTechnicalSpecs,
        stock: normalizedStock,
        status: normalizedStock > 5 ? 'In Stock' : normalizedStock > 0 ? 'Low Stock' : 'Out of Stock',
        updatedBy: req.session.email,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  if ((previous?.stock || 0) < 1 && normalizedStock > 0) await notifyBackInStockSubscribers(normalizedProductId, item.name);
  return res.status(201).json({ inventoryItem: item });
});

app.put('/api/admin/inventory/:productId', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description : '';
  const rawPricePaise = req.body?.pricePaise;
  const pricePaise = Number(rawPricePaise);
  const rawStock = req.body?.stock;
  const stock = Number(rawStock);
  const images = req.body?.images;
  const technicalSpecs = req.body?.technicalSpecs;
  const cancellable = req.body?.cancellable;
  if (!productId || productId.length > 120 || !name || name.length > 120
    || !category || category.length > 80 || description.length > 1000
    || !(typeof rawPricePaise === 'number' && Number.isSafeInteger(rawPricePaise)
      || typeof rawPricePaise === 'string' && /^\d+$/.test(rawPricePaise) && Number.isSafeInteger(pricePaise))
    || pricePaise < 0
    || !(typeof rawStock === 'number' || typeof rawStock === 'string' && /^\d+$/.test(rawStock))
    || !Number.isSafeInteger(stock) || stock < 0
    || !Array.isArray(images) || images.length > 8
    || !technicalSpecs || typeof technicalSpecs !== 'object' || Array.isArray(technicalSpecs)
    || typeof cancellable !== 'boolean') {
    return res.status(400).json({ message: 'Enter a product name, category, valid non-negative price and stock, up to 8 images, and a technical specifications object.' });
  }
  const safeImages = images.map((value) => String(value).trim()).filter(Boolean);
  if (safeImages.length !== images.filter((value) => String(value).trim()).length
    || safeImages.some((image) => image.length > 2048 || !(image.startsWith('/') && !image.startsWith('//') || /^https?:\/\//i.test(image)))) {
    return res.status(400).json({ message: 'Provide up to 8 valid image URLs.' });
  }
  const safeTechnicalSpecs = Object.fromEntries(Object.entries(technicalSpecs).slice(0, 30).map(([key, value]) => [
    String(key).trim().slice(0, 80),
    String(value).trim().slice(0, 300),
  ]).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(key) && value));
  const previous = await InventoryItem.findOne({ productId }).select('stock').lean();
  if (!previous) return res.status(404).json({ message: 'Inventory item was not found.' });
  const inventoryItem = await InventoryItem.findOneAndUpdate(
    { productId },
    { $set: {
      name,
      category,
      pricePaise,
      stock,
      description,
      images: safeImages,
      technicalSpecs: safeTechnicalSpecs,
      cancellable,
      status: stock > 5 ? 'In Stock' : stock > 0 ? 'Low Stock' : 'Out of Stock',
      updatedBy: req.session.email,
      updatedAt: new Date(),
    } },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!inventoryItem) return res.status(404).json({ message: 'Inventory item was not found.' });
  if (previous.stock < 1 && stock > 0) await notifyBackInStockSubscribers(productId, inventoryItem.name);
  return res.json({ inventoryItem });
});

app.patch('/api/admin/inventory/:productId/stock', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  const rawStock = req.body?.stock;
  const stock = Number(rawStock);
  const stockInputValid = typeof rawStock === 'number' || typeof rawStock === 'string' && /^\d+$/.test(rawStock);
  if (!productId || !stockInputValid || !Number.isSafeInteger(stock) || stock < 0) {
    return res.status(400).json({ message: 'Stock must be a non-negative whole number.' });
  }
  const previous = await InventoryItem.findOne({ productId }).select('stock').lean();
  const inventoryItem = await InventoryItem.findOneAndUpdate(
    { productId },
    { $set: { stock, status: stock > 5 ? 'In Stock' : stock > 0 ? 'Low Stock' : 'Out of Stock', updatedBy: req.session.email, updatedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!inventoryItem) return res.status(404).json({ message: 'Inventory item was not found.' });
  if ((previous?.stock || 0) < 1 && stock > 0) await notifyBackInStockSubscribers(productId, inventoryItem.name);
  return res.json({ inventoryItem });
});

app.get('/api/admin/settings', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  await loadSubscriptionPlanSettings();
  const [maxActiveOrders, graceHours] = await Promise.all([
    getOrderLimit(),
    getConfiguredGraceHours(),
  ]);
  return res.json({
    settings: {
      maxActiveOrders,
      subscriptionGraceHours: graceHours,
      plans: Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, {
        pricePaise: config.pricePaise,
        walletLimitPaise: config.walletLimitPaise,
        cashbackPaise: config.cashbackPaise,
      }])),
    },
  });
});

app.patch('/api/admin/settings/max-active-orders', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isInteger(value) || value < 1) return res.status(400).json({ message: 'Set the order capacity to a valid integer greater than zero.' });
  const setting = await AdminSetting.findOneAndUpdate(
    { key: 'max_active_orders' },
    { $set: { key: 'max_active_orders', value, updatedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return res.json({ settings: { maxActiveOrders: setting.value, subscriptionGraceHours: await getConfiguredGraceHours() } });
});

app.patch('/api/admin/settings/subscription-grace-hours', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const value = Number(req.body?.value);
  if (value !== 48) return res.status(400).json({ message: 'The subscription grace period is fixed at 48 hours.' });
  await loadSubscriptionPlanSettings();
  return res.json({ settings: { maxActiveOrders: await getOrderLimit(), subscriptionGraceHours: 48, plans: Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, { pricePaise: config.pricePaise, walletLimitPaise: config.walletLimitPaise, cashbackPaise: config.cashbackPaise }])) } });
});

app.patch('/api/admin/settings/subscription-plans', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const plans = req.body?.plans;
  if (!plans || typeof plans !== 'object' || Array.isArray(plans)) {
    return res.status(400).json({ message: 'Provide valid subscription plan settings.' });
  }
  const allowedFields = ['pricePaise', 'walletLimitPaise', 'cashbackPaise'];
  const updates = [];
  for (const [planName, config] of Object.entries(planConfig)) {
    const submitted = plans[planName];
    if (!submitted || typeof submitted !== 'object')     return res.status(400).json({ message: `Provide settings for ${displayPlanName(planName)}.` });
    for (const field of allowedFields) {
      const rawValue = submitted[field];
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value < 0) return res.status(400).json({ message: `${displayPlanName(planName)} ${field} must be a non-negative whole number of paise.` });
      updates.push(AdminSetting.findOneAndUpdate(
        { key: planSettingKey(planName, field) },
        { $set: { key: planSettingKey(planName, field), value, updatedAt: new Date() } },
        { upsert: true, setDefaultsOnInsert: true },
      ));
    }
  }
  await Promise.all(updates);
  await loadSubscriptionPlanSettings();
  return res.json({
    settings: {
      maxActiveOrders: await getOrderLimit(),
      subscriptionGraceHours: await getConfiguredGraceHours(),
      plans: Object.fromEntries(Object.entries(planConfig).map(([name, config]) => [name, {
        pricePaise: config.pricePaise,
        walletLimitPaise: config.walletLimitPaise,
        cashbackPaise: config.cashbackPaise,
      }])),
    },
  });
});

app.post('/api/admin/promo-codes', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const amountPaise = Number(req.body?.amountPaise);
  const validityDays = Number(req.body?.validityDays ?? 30);
  const validityHours = Number(req.body?.validityHours ?? 0);
  const validityMinutes = Number(req.body?.validityMinutes ?? 0);
  const maxUses = Number(req.body?.maxUses ?? 10);
  const durationPartsValid = [validityDays, validityHours, validityMinutes].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    validityHours < 24 && validityMinutes < 60;
  const validitySeconds = validityDays * 86400 + validityHours * 3600 + validityMinutes * 60;
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)) return res.status(400).json({ message: 'Promo code must use XXXX-XXXX-XXXX-XXXX format.' });
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) return res.status(400).json({ message: 'Promo amount must be greater than ₹0.' });
  if (!durationPartsValid || !Number.isSafeInteger(validitySeconds) || validitySeconds < 60 || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    return res.status(400).json({ message: 'Enter a valid promo validity of at least one minute and a maximum use limit from 1 to 1,000.' });
  }
  try {
    const promoCode = await PromoCode.create({ code, amountPaise, validitySeconds, maxUses, successfulUses: 0, status: 'unused', createdBy: req.session.sub });
    return res.status(201).json({ promoCode: { ...promoCode.toObject(), amount: money(promoCode.amountPaise) } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ code: 'PROMO_EXISTS', message: 'Promo code already exists. Please enter a different promo code.' });
    throw error;
  }
});

app.patch('/api/admin/promo-codes/:id/deactivate', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Promo code was not found.' });
  const promoCode = await PromoCode.findOneAndUpdate({ _id: req.params.id, status: 'unused' }, { $set: { status: 'deactivated' } }, { returnDocument: 'after' }).lean();
  if (!promoCode) return res.status(409).json({ message: 'Only unused promo codes can be deactivated.' });
  return res.json({ promoCode: { ...promoCode, amount: money(promoCode.amountPaise) } });
});

const promoReservationMs = 30 * 60 * 1000;
const releaseExpiredPromoReservations = async () => {
  await PromoCode.updateMany(
    { status: 'reserved', reservationExpiresAt: { $lte: new Date() } },
    {
      $set: { status: 'unused' },
      $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, razorpayOrderId: 1 },
    },
  );
};

app.get('/api/promo-codes/available', requireSession, requireDatabase, async (_req, res) => {
  await releaseExpiredPromoReservations();
  await expirePromoCodes();
  const promoCodes = await PromoCode.find({ status: 'unused', $or: [{ maxUses: { $exists: false } }, { $expr: { $lt: ['$successfulUses', '$maxUses'] } }] }).select('amountPaise createdAt validitySeconds maxUses successfulUses').sort({ createdAt: -1 }).lean();
  return res.json({ promoCodes: promoCodes.map((promo) => { const maxUses = promo.maxUses || 10; const successfulUses = promo.successfulUses || 0; return { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), createdAt: promo.createdAt, validitySeconds: promo.validitySeconds, maxUses, successfulUses, remainingUses: Math.max(0, maxUses - successfulUses), available: true }; }) });
});

app.post('/api/promo-codes/reserve', requireSession, requireDatabase, async (req, res) => {
  const { promoCodeId, reservationKey, purchaseType, recipientType = 'myself' } = req.body || {};
  if (!mongoose.isValidObjectId(promoCodeId)) return res.status(400).json({ message: 'Choose a valid Promo Code.' });
  if (!['online', 'offline'].includes(purchaseType)) return res.status(400).json({ message: 'Choose Online Purchase or Offline Purchase.' });
  if (!['myself', 'gift'].includes(recipientType)) return res.status(400).json({ message: 'Choose For Myself or Gift Purchase.' });
  if (typeof reservationKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(reservationKey)) return res.status(400).json({ message: 'A valid reservation key is required.' });
  await releaseExpiredPromoReservations();
  await expirePromoCodes();
  const existing = await PromoCode.findOne({ 'reservationOwner.userId': req.session.sub, reservationKey }).lean();
  if (existing) {
    if (String(existing._id) !== promoCodeId) return res.status(409).json({ message: 'This reservation key is already in use.' });
    if (existing.status === 'reserved' && existing.purchaseType === purchaseType && existing.recipientType === recipientType) return res.json({ reservationId: existing.reservationId, purchaseType: existing.purchaseType, recipientType: existing.recipientType, promoCode: { id: String(existing._id), name: 'Digital Wallet Credit', amount: money(existing.amountPaise), available: true }, expiresAt: existing.reservationExpiresAt });
    if (existing.status === 'reserved') return res.status(409).json({ message: 'This reservation already uses a different purchase type.' });
  }
  const now = new Date();
  const reservationId = `PR-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(now.getTime() + promoReservationMs);
  const promo = await PromoCode.findOneAndUpdate(
    { _id: promoCodeId, status: 'unused', $or: [{ maxUses: { $exists: false } }, { $expr: { $lt: ['$successfulUses', '$maxUses'] } }] },
    { $set: { status: 'reserved', reservationId, reservationKey, reservationOwner: { userId: req.session.sub }, reservationExpiresAt: expiresAt, paymentMethod: null, purchaseType, recipientType, giftBuyerId: req.session.sub, giftBuyerName: req.session.name || req.session.email.split('@')[0], giftBuyerEmail: req.session.email }, $unset: { giftRecipientId: 1, giftRecipientEmail: 1, buyerAddress: 1, recipientAddress: 1 } },
    { new: true },
  ).lean();
  if (!promo) return res.status(409).json({ message: 'This Promo Code is no longer available.' });
  return res.status(201).json({ reservationId, purchaseType: promo.purchaseType, recipientType: promo.recipientType, promoCode: { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), available: true }, expiresAt });
});

app.post('/api/promo-codes/reservations/:reservationId/recipient', requireSession, requireDatabase, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ message: 'Enter a valid recipient email address.' });
  const now = Date.now();
  const attemptKey = req.session.sub;
  const attempt = giftRecipientAttempts.get(attemptKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempt.resetAt <= now) {
    attempt.count = 0;
    attempt.resetAt = now + 15 * 60 * 1000;
  }
  attempt.count += 1;
  giftRecipientAttempts.set(attemptKey, attempt);
  if (attempt.count > 10) return res.status(429).json({ message: 'Recipient verification is temporarily limited. Please try again later.' });

  const promo = await PromoCode.findOne({
    reservationId: req.params.reservationId,
    status: 'reserved',
    'reservationOwner.userId': req.session.sub,
    purchaseType: 'online',
    recipientType: 'gift',
    reservationExpiresAt: { $gt: new Date() },
  });
  if (!promo) return res.status(404).json({ message: 'This gift reservation is no longer available.' });
  const recipient = await User.findOne({ email }).select('googleId email').lean();
  if (!recipient) return res.status(404).json({ message: 'This email address is not registered with Innovation Labs. Please ask the recipient to create an account first.' });
  promo.giftRecipientId = recipient.googleId;
  promo.giftRecipientEmail = recipient.email;
  await promo.save();
  return res.json({ verified: true, email: recipient.email });
});

app.get('/api/promo-codes/reservations/:reservationId', requireSession, requireDatabase, async (req, res) => {
  let promo = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub }).lean();
  if (!promo) return res.status(404).json({ message: 'Promo Code reservation was not found.' });
  if (promo.status === 'reserved' && promo.reservationExpiresAt <= new Date()) {
    await releaseExpiredPromoReservations();
    return res.status(409).json({ message: 'This Promo Code reservation expired. Add the code to your cart again.' });
  }
  if (!['reserved', 'pending_approval', 'purchased', 'used'].includes(promo.status)) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
  const order = ['reserved'].includes(promo.status) ? null : await Order.findOne({ orderId: promo.orderId, userId: req.session.sub }).lean();
  return res.json({
    reservationId: promo.reservationId,
    status: promo.status,
    purchaseType: promo.purchaseType || 'online',
    recipientType: promo.recipientType || 'myself',
    giftRecipientEmail: promo.giftRecipientEmail || null,
    paymentMethod: promo.paymentMethod || null,
    promoCode: { id: String(promo._id), name: 'Digital Wallet Credit', amount: money(promo.amountPaise), code: promo.recipientType === 'gift' ? null : ['purchased', 'used'].includes(promo.status) ? promo.code : null, available: promo.status === 'reserved' || promo.status === 'purchased' },
    expiresAt: promo.reservationExpiresAt,
    walletBalance: wallet && hasWalletUnlock(req) ? money(walletAvailableBalancePaise(wallet)) : null,
    orderId: promo.status === 'reserved' ? null : promo.orderId,
    order: buyerOrderView(order),
  });
});

app.post('/api/promo-codes/reservations/:reservationId/release', requireSession, requireDatabase, async (req, res) => {
  const released = await PromoCode.findOneAndUpdate(
    { reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub },
    { $set: { status: 'unused' }, $unset: { reservationId: 1, reservationKey: 1, reservationOwner: 1, reservationExpiresAt: 1, paymentMethod: 1, purchaseType: 1, recipientType: 1, giftRecipientId: 1, giftRecipientEmail: 1, giftBuyerId: 1, giftBuyerName: 1, giftBuyerEmail: 1, buyerAddress: 1, recipientAddress: 1, razorpayOrderId: 1, purchasePayableAmountPaise: 1, purchaseSubscriptionDiscountAmountPaise: 1, purchaseSubscriptionDiscountPlan: 1, purchaseSubscriptionDiscountPercent: 1 } },
  );
  return res.json({ released: Boolean(released) });
});

app.patch('/api/promo-codes/reservations/:reservationId/payment-method', requireSession, requireDatabase, async (req, res) => {
  const paymentMethod = req.body?.paymentMethod;
  if (!['Wallet', 'Razorpay'].includes(paymentMethod)) return res.status(400).json({ message: 'Choose Wallet or Razorpay.' });
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub, reservationExpiresAt: { $gt: new Date() } }).lean();
  if (!promo) return res.status(409).json({ message: 'This Promo Code reservation expired or is no longer available.' });
  if (promo.razorpayOrderId && promo.paymentMethod !== paymentMethod) return res.status(409).json({ message: 'A Razorpay payment has already been started for this reservation.' });
  const updated = await PromoCode.findOneAndUpdate(
    { _id: promo._id, status: 'reserved', reservationId: promo.reservationId, 'reservationOwner.userId': req.session.sub, reservationExpiresAt: { $gt: new Date() } },
    { $set: { paymentMethod } },
    { new: true },
  ).lean();
  if (!updated) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
  return res.json({ paymentMethod: updated.paymentMethod });
});

app.post('/api/promo-codes/reservations/:reservationId/pay-wallet', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const { pin, idempotencyKey, address, buyerAddress, recipientAddress, recipientEmail } = req.body || {};
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit Wallet PIN.' });
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid purchase key is required.' });
  const alreadyPurchased = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
  if (alreadyPurchased) {
    if (alreadyPurchased.purchaseIdempotencyKey !== idempotencyKey) return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    const order = await Order.findOne({ orderId: alreadyPurchased.orderId, userId: req.session.sub }).lean();
    const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
    return res.json({ promoCode: alreadyPurchased.recipientType === 'gift' || alreadyPurchased.purchaseType === 'offline' && !alreadyPurchased.purchasedBy?.userId ? null : { code: alreadyPurchased.code, amount: money(alreadyPurchased.amountPaise) }, order: buyerOrderView(order), wallet: { balance: money(walletAvailableBalancePaise(wallet)) }, duplicate: true });
  }
  const reservedPromo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', 'reservationOwner.userId': req.session.sub }).select('purchaseType recipientType giftRecipientId').lean();
  if (reservedPromo?.purchaseType === 'online' && reservedPromo.recipientType === 'gift' && !reservedPromo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (reservedPromo?.purchaseType === 'offline') {
    if (!validateAddress(recipientAddress || address)) return res.status(400).json({ message: 'Complete the recipient delivery address fields for Offline Purchase.' });
    if (reservedPromo.recipientType === 'gift' && !validateAddress(buyerAddress)) return res.status(400).json({ message: 'Complete the buyer contact address fields for Offline Gift Purchase.' });
  }
  const pinWallet = await Wallet.findOne({ userId: req.session.sub }).select('pinHash failedPinAttempts lockedUntil').lean();
  if (!pinWallet?.pinHash) return res.status(409).json({ message: 'Create a Wallet PIN before paying from your Wallet.' });
  if (pinWallet.lockedUntil && pinWallet.lockedUntil > new Date()) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
  if (!verifyPin(pin, pinWallet.pinHash)) {
    const failedWallet = await Wallet.findOneAndUpdate({ userId: req.session.sub, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date() } }] }, { $inc: { failedPinAttempts: 1 } }, { new: true }).select('failedPinAttempts').lean();
    if (!failedWallet) return res.status(429).json({ message: 'Wallet security verification is temporarily locked. Please try again later.' });
    if (failedWallet.failedPinAttempts >= 5) {
      await Wallet.updateOne({ userId: req.session.sub }, { $set: { failedPinAttempts: 0, lockedUntil: new Date(Date.now() + 5 * 60 * 1000) } });
      return res.status(429).json({ message: 'Too many incorrect PIN attempts. Wallet payments are locked for 5 minutes.' });
    }
    return res.status(401).json({ message: 'Incorrect Wallet PIN. Please try again.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const existing = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).session(session).lean();
      if (existing) {
        if (existing.purchaseIdempotencyKey !== idempotencyKey) throw Object.assign(new Error('This Promo Code has already been purchased.'), { status: 409 });
        const order = await Order.findOne({ orderId: existing.orderId, userId: req.session.sub }).session(session).lean();
        const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session).lean();
        return { promoCode: existing.purchaseType === 'offline' && !existing.purchasedBy?.userId ? null : existing, order, wallet, duplicate: true };
      }
      const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, reservationExpiresAt: { $gt: new Date() }, paymentMethod: 'Wallet' }).session(session);
      if (!promo) throw Object.assign(new Error('This Promo Code reservation expired or is unavailable for Wallet payment.'), { status: 409 });
      const recipient = await resolvePromoRecipient(session, { promo, userId: req.session.sub, userEmail: req.session.email, recipientEmail });
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet || !verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      if (wallet.lockedUntil && wallet.lockedUntil > new Date()) throw Object.assign(new Error('Wallet security verification is temporarily locked.'), { status: 429 });
      const subscriptionDiscount = await subscriptionDiscountForAmount(req.session.sub, promo.amountPaise, session);
      const payableAmountPaise = Math.max(0, promo.amountPaise - subscriptionDiscount.amountPaise);
      promo.purchasePayableAmountPaise = payableAmountPaise;
      promo.purchaseSubscriptionDiscountAmountPaise = subscriptionDiscount.amountPaise;
      promo.purchaseSubscriptionDiscountPlan = subscriptionDiscount.plan;
      promo.purchaseSubscriptionDiscountPercent = subscriptionDiscount.percentage;
      await assertWalletSpendAvailable(req.session.sub, wallet, payableAmountPaise, session);
      if (wallet.balancePaise < payableAmountPaise) throw Object.assign(new Error(`Insufficient Wallet Balance. Required: ₹${money(payableAmountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · Available: ₹${money(wallet.balancePaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`), { status: 402 });
      const before = wallet.balancePaise;
      wallet.balancePaise -= payableAmountPaise;
      wallet.failedPinAttempts = 0;
      wallet.lockedUntil = undefined;
      await wallet.save({ session });
      const customerDetails = {
        promo,
        reservationId: promo.reservationId,
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        paymentMethod: 'Wallet',
        idempotencyKey,
        walletBalanceAfterPaise: wallet.balancePaise,
      };
      const completed = promo.purchaseType === 'offline'
        ? await createOfflinePromoCodeOrder(session, { ...customerDetails, address: recipientAddress || address, buyerAddress, recipientAddress: recipientAddress || address, ...recipient, recipientType: promo.recipientType })
        : await completePromoCodeOrder(session, customerDetails);
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Purchase',
        amountPaise: -payableAmountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `promo-purchase:${promo.reservationId}`,
        orderId: completed.order.orderId,
        description: `Promo Code purchase ${completed.order.orderId}`,
        status: 'Successful',
      }], { session });
      return { ...completed, wallet: wallet.toObject(), duplicate: false };
    });
    if (result.cartItems) broadcastSse('cart_updated', { items: result.cartItems }, req.session.sub);
    return res.json({ promoCode: result.promoCode && result.order.recipientType !== 'gift' ? { code: result.promoCode.code, amount: money(result.promoCode.amountPaise) } : null, order: buyerOrderView(result.order), wallet: { balance: money(walletAvailableBalancePaise(result.wallet)) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const duplicate = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, purchaseIdempotencyKey: idempotencyKey, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
      if (duplicate) {
        const order = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).lean();
        const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise restrictedBalancePaise').lean();
        return res.json({ promoCode: duplicate.recipientType === 'gift' || duplicate.purchaseType === 'offline' && !duplicate.purchasedBy?.userId ? null : { code: duplicate.code, amount: money(duplicate.amountPaise) }, order: buyerOrderView(order), wallet: { balance: money(walletAvailableBalancePaise(wallet)) }, duplicate: true });
      }
      return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    }
    throw error;
  }
});

app.post('/api/promo-codes/reservations/:reservationId/razorpay/order', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const { buyerAddress, recipientAddress, address, recipientEmail } = req.body || {};
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, reservationExpiresAt: { $gt: new Date() }, paymentMethod: 'Razorpay' });
  if (!promo) return res.status(409).json({ message: 'This Promo Code reservation expired or is unavailable for Razorpay.' });
  if (promo.purchaseType === 'online' && promo.recipientType === 'gift' && !promo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (promo.purchaseType === 'offline') {
    const deliveryAddress = recipientAddress || address;
    if (!validateAddress(deliveryAddress)) return res.status(400).json({ message: 'Complete the delivery address before payment.' });
    if (promo.recipientType === 'gift' && !validateAddress(buyerAddress)) return res.status(400).json({ message: 'Complete the buyer contact address before payment.' });
    if (!promo.razorpayOrderId) {
      const recipient = await resolvePromoRecipient(null, { promo, userId: req.session.sub, userEmail: req.session.email, recipientEmail });
      promo.buyerAddress = buyerAddress || undefined;
      promo.recipientAddress = deliveryAddress;
      promo.giftRecipientId = recipient.recipientUserId || undefined;
      promo.giftRecipientEmail = recipient.recipientEmail || undefined;
      await promo.save();
    }
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for Promo Code purchases.' });
  if (promo.razorpayOrderId) return res.json({ orderId: promo.razorpayOrderId, keyId: razorpayKeyId, amountPaise: promo.amountPaise, promoCode: 'Digital Wallet Credit' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: promo.amountPaise, currency: 'INR', receipt: `promo-${promo.reservationId}`, expire_by: Math.floor(promo.reservationExpiresAt.getTime() / 1000) }),
    });
    const razorpayOrder = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the Promo Code payment.' });
    const updated = await PromoCode.findOneAndUpdate(
      { _id: promo._id, status: 'reserved', reservationId: promo.reservationId, 'reservationOwner.userId': req.session.sub, paymentMethod: 'Razorpay', razorpayOrderId: { $in: [null, ''] } },
      { $set: { razorpayOrderId: razorpayOrder.id } },
      { new: true },
    ).lean();
    if (!updated) {
      const winner = await PromoCode.findById(promo._id).lean();
      if (!winner?.razorpayOrderId) return res.status(409).json({ message: 'This Promo Code reservation is no longer available.' });
      return res.json({ orderId: winner.razorpayOrderId, keyId: razorpayKeyId, amountPaise: winner.amountPaise, promoCode: 'Digital Wallet Credit' });
    }
    return res.json({ orderId: updated.razorpayOrderId, keyId: razorpayKeyId, amountPaise: updated.amountPaise, promoCode: 'Digital Wallet Credit' });
  } catch {
    return res.status(503).json({ message: 'Promo Code online payment is temporarily unavailable.' });
  }
});

app.post('/api/promo-codes/reservations/:reservationId/razorpay/verify', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const orderId = req.body?.razorpay_order_id;
  const paymentId = req.body?.razorpay_payment_id;
  const signature = req.body?.razorpay_signature;
  if (![orderId, paymentId, signature].every((value) => typeof value === 'string' && value)) return res.status(400).json({ message: 'Promo Code payment verification details are incomplete.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured for Promo Code purchases.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (expectedSignature !== signature) return res.status(401).json({ message: 'Payment verification failed.' });
  const promo = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, paymentMethod: 'Razorpay', razorpayOrderId: orderId }).lean();
  if (!promo) {
    const offlinePurchase = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, status: 'pending_approval', razorpayPaymentId: paymentId }).lean();
    if (offlinePurchase) {
      const order = await Order.findOne({ orderId: offlinePurchase.orderId, userId: req.session.sub }).lean();
      return res.json({ promoCode: null, order: buyerOrderView(order), duplicate: true });
    }
    const purchased = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, razorpayPaymentId: paymentId, status: { $in: ['purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
    if (purchased) {
      const order = await Order.findOne({ orderId: purchased.orderId, userId: req.session.sub }).lean();
      return res.json({ promoCode: purchased.recipientType === 'gift' ? null : { code: purchased.code, amount: money(purchased.amountPaise) }, order: buyerOrderView(order), duplicate: true });
    }
    return res.status(404).json({ message: 'Promo Code reservation was not found.' });
  }
  if (promo.purchaseType === 'online' && promo.recipientType === 'gift' && !promo.giftRecipientId) return res.status(409).json({ message: 'Verify the gift recipient email before continuing to payment.' });
  if (promo.purchaseType === 'offline' && (!validateAddress(promo.recipientAddress) || promo.recipientType === 'gift' && !validateAddress(promo.buyerAddress))) return res.status(409).json({ message: 'The saved delivery addresses could not be verified.' });
  try {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
    const payment = await response.json();
    if (!response.ok || payment.amount !== promo.amountPaise || payment.order_id !== orderId || payment.currency !== 'INR' || payment.status !== 'captured') {
      return res.status(409).json({ message: 'Payment amount or status could not be verified.' });
    }
  } catch {
    return res.status(503).json({ message: 'Promo Code payment verification is temporarily unavailable.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const current = await PromoCode.findOne({ reservationId: req.params.reservationId, status: 'reserved', reservationOwner: { userId: req.session.sub }, paymentMethod: 'Razorpay', razorpayOrderId: orderId, reservationExpiresAt: { $gt: new Date() } }).session(session);
      if (!current) throw Object.assign(new Error('This Promo Code reservation expired or is no longer available.'), { status: 409 });
      const purchaseDetails = {
        promo: current,
        reservationId: current.reservationId,
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        paymentMethod: 'Razorpay',
        idempotencyKey: `rzp:${paymentId}`,
        razorpayPaymentId: paymentId,
      };
      const recipient = await resolvePromoRecipient(session, { promo: current, userId: req.session.sub, userEmail: req.session.email, recipientEmail: current.giftRecipientEmail });
      const completed = current.purchaseType === 'offline'
        ? await createOfflinePromoCodeOrder(session, { ...purchaseDetails, address: current.recipientAddress, buyerAddress: current.buyerAddress, recipientAddress: current.recipientAddress, ...recipient, recipientType: current.recipientType })
        : await completePromoCodeOrder(session, purchaseDetails);
      return { ...completed, duplicate: false };
    });
    if (result.cartItems) broadcastSse('cart_updated', { items: result.cartItems }, req.session.sub);
    return res.json({ promoCode: result.promoCode && result.order.recipientType !== 'gift' ? { code: result.promoCode.code, amount: money(result.promoCode.amountPaise) } : null, order: buyerOrderView(result.order), duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const duplicate = await PromoCode.findOne({ reservationId: req.params.reservationId, 'reservationOwner.userId': req.session.sub, razorpayPaymentId: paymentId, status: { $in: ['pending_approval', 'purchased', 'used', 'expired', 'fully_redeemed'] } }).lean();
      if (duplicate) {
        const order = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).lean();
        return res.json({ promoCode: duplicate.recipientType === 'gift' || duplicate.purchaseType === 'offline' && !duplicate.purchasedBy?.userId ? null : { code: duplicate.code, amount: money(duplicate.amountPaise) }, order: buyerOrderView(order), duplicate: true });
      }
      return res.status(409).json({ message: 'This Promo Code has already been purchased.' });
    }
    throw error;
  }
});

app.get('/api/wallet/promo-codes', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  await expirePromoCodes();
  const promos = await PromoCode.find({
    'purchasedBy.userId': req.session.sub,
    status: { $in: ['purchased', 'expired', 'fully_redeemed', 'used'] },
  }).sort({ activatedAt: -1, purchasedAt: -1 }).lean();
  const promoCodes = promos.map((promo) => ({
    id: promo._id,
    code: promo.code,
    amount: money(promo.amountPaise),
    status: promo.status === 'used' ? 'fully_redeemed' : promo.status,
    activatedAt: promo.activatedAt || null,
    expiresAt: promo.expiresAt || null,
    maxUses: promo.maxUses || (promo.status === 'used' ? 1 : 10),
    successfulUses: promo.successfulUses || (promo.status === 'used' ? promo.maxUses || 1 : 0),
    remainingUses: Math.max(0, (promo.maxUses || (promo.status === 'used' ? 1 : 10)) - (promo.successfulUses || (promo.status === 'used' ? promo.maxUses || 1 : 0))),
    gift: Boolean(promo.giftBuyerId && promo.giftBuyerId !== promo.purchasedBy.userId),
    buyerName: promo.giftBuyerName || null,
    buyerEmail: promo.giftBuyerEmail || null,
    orderId: promo.orderId || null,
  }));
  return res.json({ promoCodes });
});

app.post('/api/wallet/promo/redeem', requireSession, requireDatabase, requireWalletUnlock, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(code)) return res.status(400).json({ code: 'INVALID_PROMO', message: 'Enter a valid promo code in XXXX-XXXX-XXXX-XXXX format.' });
  await expirePromoCodes();
  try {
    const result = await withMongoTransaction(async (session) => {
      const promo = await PromoCode.findOne({ code }).session(session);
      if (!promo) throw Object.assign(new Error('This promo code is invalid or does not exist.'), { status: 404, code: 'INVALID_PROMO' });
      const now = new Date();
      if (promo.status === 'purchased' && promo.expiresAt && promo.expiresAt <= now) {
        await PromoCode.updateOne({ _id: promo._id, status: 'purchased', expiresAt: { $lte: now } }, { $set: { status: 'expired' } }, { session });
        if (promo.orderId) await Order.updateOne({ orderId: promo.orderId, promoCodeId: promo._id }, { $set: { promoActivationStatus: 'expired', promoCodeStatus: 'EXPIRED' } }, { session });
        return { expired: true };
      }
      if (['used', 'fully_redeemed'].includes(promo.status)) throw Object.assign(new Error('This promo code has reached its maximum successful redemptions.'), { status: 409, code: 'PROMO_USED' });
      if (promo.status === 'expired') throw Object.assign(new Error('This promo code has expired.'), { status: 410, code: 'PROMO_EXPIRED' });
      if (promo.status !== 'purchased' || promo.purchasedBy?.userId !== req.session.sub) {
        throw Object.assign(new Error('Purchase this promo code before redeeming it in your Wallet.'), { status: 409, code: 'PROMO_NOT_PURCHASED' });
      }

      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet) throw Object.assign(new Error('Create your wallet PIN before redeeming a promo code.'), { status: 409, code: 'WALLET_SETUP_REQUIRED' });
      const successfulUses = promo.successfulUses || 0;
      const maxUses = promo.maxUses || 10;
      if (successfulUses >= maxUses) {
        await PromoCode.updateOne({ _id: promo._id, status: 'purchased', successfulUses }, { $set: { status: 'fully_redeemed' } }, { session });
        return { exhausted: true };
      }
      const nextSuccessfulUses = successfulUses + 1;
      const changed = await PromoCode.updateOne(
        {
          _id: promo._id,
          status: 'purchased',
          'purchasedBy.userId': req.session.sub,
          $and: [
            { $or: [{ successfulUses }, { successfulUses: { $exists: false } }] },
            { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
          ],
        },
        { $inc: { successfulUses: 1 }, $set: { usedBy: { userId: req.session.sub, name: req.session.name || '', email: req.session.email }, usedAt: now } },
        { session },
      );
      if (!changed.modifiedCount) throw Object.assign(new Error('This promo code has already been redeemed.'), { status: 409, code: 'PROMO_USED' });
      const fullyRedeemed = nextSuccessfulUses >= maxUses;
      if (fullyRedeemed) await PromoCode.updateOne({ _id: promo._id, status: 'purchased', successfulUses: nextSuccessfulUses }, { $set: { status: 'fully_redeemed' } }, { session });
      if (promo.orderId) await Order.updateOne({ orderId: promo.orderId, promoCodeId: promo._id, orderType: 'PROMO_CODE' }, { $set: { promoCodeStatus: fullyRedeemed ? 'FULLY_REDEEMED' : 'PARTIALLY_REDEEMED', promoActivationStatus: fullyRedeemed ? 'fully_redeemed' : 'active', promoSuccessfulUses: nextSuccessfulUses, promoMaxUses: maxUses } }, { session });

      const before = wallet.balancePaise;
      wallet.balancePaise += promo.amountPaise;
      await wallet.save({ session });
      const referenceId = `promo:${promo.code}:${nextSuccessfulUses}`;
      const [transaction] = await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Promo Code',
        amountPaise: promo.amountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `Promo Code: ${promo.code}`,
        status: 'Successful',
      }], { session });
      await Notification.create([{ userId: req.session.sub, message: `A Promo Code redemption added ₹${money(promo.amountPaise).toLocaleString('en-IN')} to your Wallet. ${fullyRedeemed ? 'This code has reached its usage limit.' : `${maxUses - nextSuccessfulUses} uses remain.`}` }], { session });
      return { expired: false, exhausted: false, amountPaise: promo.amountPaise, wallet: wallet.toObject(), transaction: transaction.toObject(), successfulUses: nextSuccessfulUses, remainingUses: Math.max(0, maxUses - nextSuccessfulUses), fullyRedeemed };
    });
    if (result.expired) return res.status(410).json({ code: 'PROMO_EXPIRED', message: 'This promo code has expired.' });
    if (result.exhausted) return res.status(409).json({ code: 'PROMO_USED', message: 'This promo code has reached its maximum successful redemptions.' });
    const wallet = walletView(result.wallet, [result.transaction]);
    return res.json({ amount: money(result.amountPaise), balance: wallet.balance, availableBalance: wallet.availableBalance, restrictedBalance: wallet.restrictedBalance, totalBalance: wallet.totalBalance, successfulUses: result.successfulUses, remainingUses: result.remainingUses, fullyRedeemed: result.fullyRedeemed, transaction: wallet.transactions[0] });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ code: error.code, message: error.message });
    throw error;
  }
});

app.post('/api/wallet/pin', requireSession, requireDatabase, async (req, res) => {
  const { pin } = req.body || {};
  if (!validatePin(pin)) return res.status(400).json({ message: 'Wallet PIN must contain exactly 4 digits.' });
  const existing = await Wallet.findOne({ userId: req.session.sub }).lean();
  if (existing?.pinHash) return res.status(409).json({ message: 'A wallet PIN already exists.' });
  if (existing) {
    const updated = await Wallet.updateOne({ userId: req.session.sub, pinHash: '' }, { $set: { pinHash: hashPin(pin) } });
    if (!updated.modifiedCount) return res.status(409).json({ message: 'A wallet PIN already exists.' });
  }
  else await Wallet.create({ userId: req.session.sub, pinHash: hashPin(pin), balancePaise: 0 });
  issueWalletUnlock(res, req.session);
  return res.status(201).json({ created: true });
});

app.post('/api/wallet/unlock', requireSession, requireDatabase, async (req, res) => {
  const { pin } = req.body || {};
  const wallet = await Wallet.findOne({ userId: req.session.sub });
  if (!wallet) return res.status(409).json({ message: 'Create your wallet PIN first.' });
  const now = new Date();
  if (wallet.lockedUntil && wallet.lockedUntil > now) return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
  if (!validatePin(pin) || !verifyPin(pin, wallet.pinHash)) {
    const nextFailureCount = { $add: [{ $ifNull: ['$failedPinAttempts', 0] }, 1] };
    const shouldLock = { $gte: [nextFailureCount, 5] };
    const failedAttempt = await Wallet.findOneAndUpdate(
      {
        _id: wallet._id,
        pinHash: wallet.pinHash,
        $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
      },
      [{
        $set: {
          failedPinAttempts: { $cond: [shouldLock, 0, nextFailureCount] },
          lockedUntil: { $cond: [shouldLock, new Date(now.getTime() + 5 * 60 * 1000), '$lockedUntil'] },
        },
      }],
      { new: true },
    ).select('lockedUntil').lean();
    if (!failedAttempt) return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
    if (failedAttempt.lockedUntil && failedAttempt.lockedUntil > now) {
      return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
    }
    return res.status(401).json({ message: 'Incorrect PIN. Please try again.' });
  }
  const unlocked = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      pinHash: wallet.pinHash,
      $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
    },
    { $set: { failedPinAttempts: 0 }, $unset: { lockedUntil: 1 } },
    { new: true },
  );
  if (!unlocked) return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
  const syncedWallet = await syncWalletRestrictionState(req.session.sub);
  const transactions = await WalletTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(100).lean();
  const planState = await getWalletLimitStatus(req.session.sub, syncedWallet?.balancePaise || 0);
  issueWalletUnlock(res, req.session);
  return res.json({ wallet: walletView(syncedWallet || wallet.toObject(), transactions, planState) });
});

app.post('/api/wallet/recharge/order', requireSession, requireDatabase, requirePurchaseAge, requireWalletUnlock, async (req, res) => {
  const amountPaise = Number(req.body?.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise < 1000) return res.status(400).json({ message: 'Minimum wallet recharge is ₹10.' });
  const wallet = await Wallet.findOne({ userId: req.session.sub }).select('balancePaise').lean();
  const limitState = await getWalletLimitStatus(req.session.sub, wallet?.balancePaise || 0);
  if ((wallet?.balancePaise || 0) + amountPaise > limitState.maximumBalancePaise) {
    return res.status(409).json({ message: `This recharge would exceed your ${displayPlanName(limitState.plan)} wallet limit of ${money(limitState.maximumBalancePaise)}. You can add up to ${money(limitState.availableDepositCapacityPaise)} more.`, maximumBalance: money(limitState.maximumBalancePaise), availableDepositCapacity: money(limitState.availableDepositCapacityPaise) });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Wallet payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the server environment.' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: `wallet-${req.session.sub}-${Date.now()}` }),
    });
    const order = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'Razorpay could not create the recharge order.' });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise });
  } catch {
    return res.status(503).json({ message: 'Recharge service is temporarily unavailable.' });
  }
});

app.post('/api/wallet/recharge/verify', requireSession, requireDatabase, requirePurchaseAge, requireWalletUnlock, async (req, res) => {
  const body = req.body || {};
  const razorpayPaymentId = body.razorpayPaymentId || body.razorpay_payment_id;
  const razorpayOrderId = body.razorpayOrderId || body.razorpay_order_id;
  const razorpaySignature = body.razorpaySignature || body.razorpay_signature;
  const { amountPaise } = body;
  const requestedPaise = Number(amountPaise);
  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature || !Number.isInteger(requestedPaise) || requestedPaise < 1000) {
    return res.status(400).json({ message: 'A valid recharge payment verification is required.' });
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Wallet payments are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to the server environment.' });
  const expectedSignature = crypto.createHmac('sha256', razorpayKeySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  if (expectedSignature !== razorpaySignature) return res.status(401).json({ message: 'Recharge payment verification failed.' });
  try {
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.amount !== requestedPaise || payment.order_id !== razorpayOrderId || payment.status !== 'captured') {
      return res.status(409).json({ message: 'Recharge payment amount or status could not be verified.' });
    }
  } catch {
    return res.status(503).json({ message: 'Recharge verification is temporarily unavailable.' });
  }

  const referenceId = `recharge:${razorpayPaymentId}`;
  const result = await withMongoTransaction(async (session) => {
    const existing = await WalletTransaction.findOne({ referenceId }).session(session).lean();
    if (existing) return { duplicate: true, wallet: await Wallet.findOne({ userId: req.session.sub }).session(session).lean() };
    const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
    if (!wallet) throw Object.assign(new Error('Create and unlock your wallet before recharging.'), { status: 409 });
    const limitState = await getWalletLimitStatus(req.session.sub, wallet.balancePaise, session);
    if (wallet.balancePaise + requestedPaise > limitState.maximumBalancePaise) {
      throw Object.assign(new Error(`This recharge would exceed your ${displayPlanName(limitState.plan)} wallet limit of ${money(limitState.maximumBalancePaise)}. You can add up to ${money(limitState.availableDepositCapacityPaise)} more.`, { status: 409, maximumBalance: money(limitState.maximumBalancePaise) }));
    }
    const before = wallet.balancePaise;
    wallet.balancePaise += requestedPaise;
    await wallet.save({ session });
    await WalletTransaction.create([{ userId: req.session.sub, type: 'Recharge', amountPaise: requestedPaise, balanceBeforePaise: before, balanceAfterPaise: wallet.balancePaise, referenceId, description: 'Wallet recharge', status: 'Successful' }], { session });
    await createInvoiceForStandalonePurchase(session, { userId: req.session.sub, orderId: referenceId, paymentId: razorpayPaymentId, paymentMethod: 'Razorpay', itemName: 'Wallet Recharge', amountPaise: requestedPaise });
    return { duplicate: false, wallet: wallet.toObject() };
  });
  return res.json({ duplicate: result.duplicate, wallet: walletView(result.wallet) });
});

app.post('/api/wallet/pay', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const { items, address, service = 'parts', projectDescription = '', pin, idempotencyKey, discountCode, checkoutReference, paymentChannel, checkoutQrPayload, payerWalletId } = req.body || {};
  if (!validatePin(pin) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Wallet PIN and a valid payment reference are required.' });
  if (payerWalletId) return res.status(409).json({ message: 'Wallet ID payments require explicit approval from the Wallet owner.' });
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  if (paymentChannel === 'checkout-qr') {
    const subscription = await currentSubscription(req.session.sub);
    if (subscription?.plan !== 'Exclusive') return res.status(403).json({ message: 'Checkout QR payments are available to active Exclusive subscribers only.' });
    const qrRequest = verifyCheckoutQrPayload(checkoutQrPayload);
    if (!checkoutReference || !qrRequest || qrRequest.reference !== checkoutReference) {
      return res.status(400).json({ message: 'The checkout QR payment request must be verified before payment.' });
    }
  }
  const { safeItems, customOrders } = await resolveOrderItems(items, req.session.sub);
  const deliveryRequired = orderRequiresDelivery(safeItems);
  if (deliveryRequired && !validateAddress(address)) return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  const calculated = calculateOrder(safeItems, service);
  const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const normalizedPayerWalletId = normalizeWalletId(payerWalletId);
      const walletQuery = normalizedPayerWalletId ? { walletId: normalizedPayerWalletId } : { userId: req.session.sub };
      const payerWallet = await Wallet.findOne(walletQuery).session(session);
      if (!payerWallet) throw Object.assign(new Error('This Wallet ID does not exist. Please check and try again.'), { status: 404 });
      const payerUserId = payerWallet.userId;
      const duplicate = await WalletTransaction.findOne({ userId: payerUserId, referenceId: `wallet-payment:${idempotencyKey}` }).session(session).lean();
      const wallet = payerWallet;
      await enforceOrderLimit(session);
      if (!wallet?.pinHash) throw Object.assign(new Error('Create a Wallet PIN before paying from your Wallet.'), { status: 409 });
      if (!verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Incorrect Wallet PIN. Please try again.'), { status: 401 });
      if (duplicate) {
        const existingOrder = await Order.findOne({ orderId: duplicate.orderId, userId: req.session.sub }).session(session).lean();
        if (!existingOrder) throw Object.assign(new Error('This wallet payment has already been processed.'), { status: 409 });
        return { order: existingOrder, wallet: wallet.toObject(), payerUserId, duplicate: true };
      }
      const checkoutAttempt = checkoutReference
        ? await CheckoutAttempt.findOne({ reference: checkoutReference, userId: req.session.sub, status: 'Open' }).session(session)
        : null;
      if (checkoutReference && !checkoutAttempt) throw Object.assign(new Error('This checkout is no longer active.'), { status: 409 });
      const discount = discountCode ? await discountCodeContext({ session, userId: req.session.sub, code: discountCode, items: safeItems }) : null;
      const discountAmountPaise = discount?.discountAmountPaise || 0;
      const subscriptionDiscount = await subscriptionDiscountForAmount(
        req.session.sub,
        Math.max(0, calculated.totalPaise - discountAmountPaise),
        session,
      );
      const totalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise - subscriptionDiscount.amountPaise);
      if (checkoutAttempt && !checkoutAttemptMatches(checkoutAttempt, { items: safeItems, service, totalPaise })) {
        const message = checkoutAttemptProductChanged(checkoutAttempt, safeItems)
          ? 'A product price changed after checkout began. Review the latest cart and total before paying.'
          : 'The checkout contents or total changed. Return to checkout and try again.';
        throw Object.assign(new Error(message), { status: 409 });
      }
      const limitState = await getWalletLimitStatus(payerUserId, wallet.balancePaise, session);
      const spendCheck = enforceAvailableWalletSpendLimit(wallet.balancePaise, totalPaise, limitState, 'Wallet balance');
      if (!spendCheck.allowed) throw Object.assign(new Error(spendCheck.message), { status: 409, balance: money(spendCheck.availableBalancePaise), required: money(totalPaise), availableBalance: money(spendCheck.availableBalancePaise), restrictedBalance: money(spendCheck.restrictedBalancePaise) });
      if (wallet.balancePaise < totalPaise) throw Object.assign(new Error('Insufficient wallet balance.'), { status: 402, balance: money(spendCheck.availableBalancePaise), required: money(totalPaise) });
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems, { validateProductSnapshot: true });
      const before = wallet.balancePaise;
      wallet.balancePaise -= totalPaise;
      await wallet.save({ session });
      const [order] = await Order.create([{
        orderId,
        orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        items: orderItemsSnapshot(safeItems),
        address: deliveryRequired ? address : null,
        deliveryRequired,
        service,
        projectDescription: String(projectDescription).slice(0, 2000),
        subtotal: money(calculated.subtotalPaise),
        discountAmountPaise,
        discountCode: discount?.code || '',
        subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
        subscriptionDiscountPlan: subscriptionDiscount.plan,
        subscriptionDiscountPercent: subscriptionDiscount.percentage,
        codingCharge: money(calculated.codingChargePaise),
        buildingCharge: money(calculated.buildingChargePaise),
        deliveryCharge: money(calculated.deliveryChargePaise),
        total: money(totalPaise),
        paymentStatus: 'Paid',
        paymentMethod: 'Wallet',
        payerWalletId: wallet.walletId,
        verifiedAmountPaidPaise: totalPaise,
        paymentVerifiedAt: new Date(),
        originalPaymentReference: `wallet-payment:${idempotencyKey}`,
        walletBalanceAfterPaise: wallet.balancePaise,
        inventoryDeductedAt,
        orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Order paid from wallet', createdAt: new Date() }],
        checkoutReference: checkoutAttempt?.reference,
      }], { session });
      const discountCodes = await fulfillDiscountOfferItems(session, safeItems, { userId: req.session.sub, orderId });
      if (discount) await redeemDiscountCode(session, { userId: req.session.sub, code: discount.code, items: safeItems, orderId });
      await awardRewardPointsForOrder(session, order);
      await WalletTransaction.create([{ userId: payerUserId, type: 'Purchase', amountPaise: -totalPaise, balanceBeforePaise: before, balanceAfterPaise: wallet.balancePaise, payerWalletId: wallet.walletId, referenceId: `wallet-payment:${idempotencyKey}`, orderId, description: `Purchase ${orderId} for ${req.session.email}`, status: 'Successful' }], { session });
      await createInvoiceForOrder(session, order);
      await createScratchCardForOrder(session, order);
      if (customOrders.length) await CustomOrder.updateMany({ _id: { $in: customOrders.map((item) => item._id) }, userId: req.session.sub, status: 'Accepted' }, { $set: { status: 'Ordered', orderedAt: new Date() } }, { session });
      await Notification.create([{ userId: req.session.sub, message: `Order ${orderId} was paid from an Innovation Labs Wallet.` }], { session });
      if (checkoutAttempt) {
        checkoutAttempt.status = 'Completed';
        checkoutAttempt.paymentStatus = 'Paid';
        checkoutAttempt.paymentReference = `wallet-payment:${idempotencyKey}`;
        checkoutAttempt.completedAt = new Date();
        await checkoutAttempt.save({ session });
      }
      const cartItems = checkoutAttempt
        ? await removeOrderedItemsFromCart(session, req.session.sub, order.items)
        : null;
      return { order, discountCodes, wallet: wallet.toObject(), payerUserId, cartItems, checkoutOwnerId: checkoutAttempt ? req.session.sub : null };
    });
    const savedOrder = result.order.toObject ? result.order.toObject() : result.order;
    const discountCodes = result.discountCodes || await discountCodesForOrder(savedOrder.orderId);
    const cancellation = cancellationEligibilityFor(savedOrder, Boolean(discountCodes.length));
    const refund = refundEligibilityFor(savedOrder, null);
    const order = {
      ...savedOrder,
      discountCodes,
      cancelEligible: cancellation.eligible,
      cancellationEligibility: { eligible: cancellation.eligible, reason: cancellation.reason },
      refundEligible: refund.eligible,
      refundEligibility: { eligible: refund.eligible, reason: refund.reason, deliveredAt: refund.deliveredAt, eligibleAt: refund.eligibleAt },
      refundCase: null,
    };
    const transactionId = `wallet-payment:${idempotencyKey}`;
    broadcastOrderEvent(savedOrder, 'payment_success', { transactionId, amount: savedOrder.total });
    broadcastOrderEvent(savedOrder, 'order_created', { transactionId, amount: savedOrder.total });
    if (result.cartItems) broadcastSse('cart_updated', { items: result.cartItems }, result.checkoutOwnerId);
    broadcastSse('wallet_balance_updated', {
      userId: result.payerUserId,
      balance: money(result.wallet.balancePaise),
      availableBalance: money(walletAvailableBalancePaise(result.wallet)),
    }, result.payerUserId);
    return res.status(result.duplicate ? 200 : 201).json({ order, wallet: walletView(result.wallet), duplicate: result.duplicate });
  } catch (error) {
    if (error.status) {
      if (checkoutReference) {
        try {
          const paidOrder = await Order.exists({
            checkoutReference,
            userId: req.session.sub,
            paymentStatus: 'Paid',
          });
          if (!paidOrder) {
            await CheckoutAttempt.updateOne(
              { reference: checkoutReference, userId: req.session.sub, status: 'Open' },
              { $set: { paymentStatus: 'Failed', reason: error.message } },
            );
          }
        } catch (recordError) {
          console.error('Wallet checkout failure status could not be recorded:', recordError.message);
        }
      }
      return res.status(error.status).json({ message: error.message, balance: error.balance, required: error.required });
    }
    throw error;
  }
});

app.get('/api/refunds', requireSession, requireDatabase, async (req, res) => {
  const refunds = await Refund.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean();
  return res.json({ refunds });
});

app.get('/api/refunds/eligibility/:orderId', requireSession, requireDatabase, async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.orderId, userId: req.session.sub }).lean();
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  const existing = await Refund.findOne({ orderId: order.orderId }).lean();
  const eligibility = refundEligibilityFor(order, existing);
  return res.json({
    eligibility: { eligible: eligibility.eligible, reason: eligibility.reason, deliveredAt: eligibility.deliveredAt, eligibleAt: eligibility.eligibleAt },
    refund: existing ? { _id: existing._id, refundCaseId: existing.refundCaseId, status: existing.status, refundAmountPaise: existing.refundAmountPaise } : null,
    order: {
      orderId: order.orderId,
      userName: order.userName,
      userEmail: order.userEmail,
      createdAt: order.createdAt,
      deliveredAt: eligibility.deliveredAt,
      items: order.items,
      total: order.total,
      paymentMethod: order.paymentMethod,
      address: order.address,
    },
  });
});

app.post('/api/refunds', requireSession, requireDatabase, refundEvidenceUpload, async (req, res) => {
  const { orderId, reason = '', reasonCategory = 'Other' } = req.body || {};
  if (typeof orderId !== 'string' || !orderId.trim()) return res.status(400).json({ message: 'An order ID is required.' });
  if (!req.file) return res.status(400).json({ message: 'Upload a photo of the item as refund evidence.' });
  const detectedContentType = identifyRefundImage(req.file.buffer);
  if (!detectedContentType || detectedContentType !== req.file.mimetype) {
    return res.status(400).json({ message: 'The uploaded file is not a valid JPEG, PNG, or WebP image.' });
  }
  const validReasons = ['Damaged item', 'Wrong item received', 'Item does not match order', 'Product issue', 'Other'];
  const normalizedReason = String(reason).trim().slice(0, 1000);
  if (!validReasons.includes(reasonCategory)) return res.status(400).json({ message: 'Choose a valid refund reason.' });
  if (!normalizedReason || (reasonCategory === 'Other' && normalizedReason.length < 10)) {
    return res.status(400).json({ message: 'Please describe the refund issue. Other reasons need at least 10 characters.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const order = await Order.findOne({ orderId: orderId.trim(), userId: req.session.sub }).session(session).lean();
      if (!order) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      const existing = await Refund.findOne({ orderId: order.orderId }).session(session).lean();
      const eligibility = refundEligibilityFor(order, existing);
      if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { status: 409, refund: existing });
      if (order.paymentStatus !== 'Paid') throw Object.assign(new Error('Only paid orders can be refunded.'), { status: 409 });
      const originalOrderAmountPaise = toPaise(order.total);
      if (!Number.isSafeInteger(originalOrderAmountPaise) || originalOrderAmountPaise <= 0) {
        throw Object.assign(new Error('The order does not have an eligible paid amount.'), { status: 409 });
      }
      const refundCaseId = `RF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const claimedOrder = await Order.updateOne(
        { orderId: order.orderId, userId: req.session.sub, refundCaseId: null },
        { $set: { refundCaseId } },
        { session },
      );
      if (!claimedOrder.modifiedCount) throw Object.assign(new Error('A refund case already exists for this order.'), { status: 409 });
      const evidenceFileName = String(req.file.originalname || 'evidence').replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
      const [refund] = await Refund.create([{
        refundCaseId,
        orderId: order.orderId,
        userId: req.session.sub,
        userName: order.userName,
        userEmail: order.userEmail,
        originalOrderAmountPaise,
        calculatedRefundAmountPaise: originalOrderAmountPaise,
        approvedRefundAmountPaise: originalOrderAmountPaise,
        refundAmountPaise: originalOrderAmountPaise,
        itemsSnapshot: order.items.map(({ id, name, category, price, quantity }) => ({ id, name, category, price, quantity })),
        orderSnapshot: {
          createdAt: order.createdAt,
          deliveredAt: eligibility.deliveredAt,
          total: order.total,
          subtotal: order.subtotal,
          deliveryCharge: order.deliveryCharge,
          codingCharge: order.codingCharge,
          buildingCharge: order.buildingCharge,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          address: order.address,
        },
        reason: normalizedReason,
        reasonCategory,
        evidence: { fileName: evidenceFileName, contentType: detectedContentType, size: req.file.size, data: req.file.buffer },
        status: 'REFUND_PLACED',
        statusHistory: [{ status: 'REFUND_PLACED', changedBy: req.session.sub, note: 'Refund request submitted.', createdAt: new Date() }],
      }], { session });
      await Notification.create([{ userId: req.session.sub, message: `Refund request ${refundCaseId} has been received.` }], { session });
      return refund;
    });
    const createdRefund = result.toObject();
    if (createdRefund.evidence) delete createdRefund.evidence.data;
    return res.status(201).json({ refund: createdRefund });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message, refund: error.refund ? { _id: error.refund._id, refundCaseId: error.refund.refundCaseId, status: error.refund.status } : undefined });
    if (error.code === 11000) return res.status(409).json({ message: 'A refund case already exists for this order.' });
    throw error;
  }
});

app.get('/api/refunds/:id/evidence', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund evidence was not found.' });
  const refund = await Refund.findById(req.params.id).select('+evidence.data').lean();
  if (!refund?.evidence?.data) return res.status(404).json({ message: 'Refund evidence was not found.' });
  const isOwner = refund.userId === req.session.sub;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (!isOwner && !isAdmin) return res.sendStatus(403);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `inline; filename="${refund.evidence.fileName || 'refund-evidence'}"`);
  return res.type(refund.evidence.contentType).send(refund.evidence.data);
});

app.get('/api/refunds/:id', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund case was not found.' });
  const refund = await Refund.findOne({ _id: req.params.id, userId: req.session.sub }).lean();
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  return res.json({ refund });
});

app.get('/api/admin/refunds', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const refunds = await Refund.find().sort({ createdAt: -1 }).lean();
  return res.json({ refunds });
});

app.get('/api/admin/refunds/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Refund case was not found.' });
  const refund = await Refund.findById(req.params.id).lean();
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  const order = await Order.findOne({ orderId: refund.orderId, userId: refund.userId }).lean();
  return res.json({ refund, order: order ? { ...order, items: refund.itemsSnapshot?.length ? refund.itemsSnapshot : order.items } : null });
});

app.patch('/api/admin/refunds/:id/status', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const { action, reason = '' } = req.body || {};
  const refund = await Refund.findOne({ _id: req.params.id });
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  const transitions = {
    check: { from: 'REFUND_PLACED', to: 'ORDER_CHECKING', note: 'Order check started.' },
    return: { from: 'ORDER_CHECKING', to: 'RETURN_REQUIRED', note: 'Return or collection is required.' },
    arrived: { from: 'RETURN_REQUIRED', to: 'PACKAGE_ARRIVED', note: 'Returned package received.' },
    inspect: { from: 'PACKAGE_ARRIVED', to: 'PART_CHECKING', note: 'Item inspection started.' },
    accept: { from: 'PART_CHECKING', to: 'ORDER_ACCEPTED', note: 'Returned item passed inspection; refund accepted.' },
    process: { from: 'ORDER_ACCEPTED', to: 'REFUND_PROCESSING', note: 'Refund processing started.' },
    initiate: { from: 'REFUND_PROCESSING', to: 'REFUND_INITIATED', note: 'Refund initialized; wallet credit is pending.' },
  };
  if (action === 'decline' && refund.status === 'PART_CHECKING') {
    const declineReason = String(reason).trim().slice(0, 1000);
    if (!declineReason) return res.status(400).json({ message: 'A reason is required to decline a refund.' });
    refund.adminReason = declineReason;
    setRefundStatus(refund, 'ORDER_DECLINED', req.session.email, declineReason, 'refund_declined');
    setRefundStatus(refund, 'REFUND_REJECTED', req.session.email, declineReason, 'refund_declined');
  } else {
    const transition = transitions[action];
    if (!transition || refund.status !== transition.from) return res.status(409).json({ message: 'This refund cannot move to that stage.' });
    setRefundStatus(refund, transition.to, req.session.email, transition.note, action);
  }
  await refund.save();
  const notifications = {
    ORDER_CHECKING: 'Your refund request is being reviewed.',
    RETURN_REQUIRED: 'Please keep the ordered item ready at the delivery address for return or collection instructions.',
    PACKAGE_ARRIVED: 'Your returned package has been received.',
    PART_CHECKING: 'Your returned item is being inspected against the original order.',
    ORDER_ACCEPTED: 'Your refund has been accepted.',
    ORDER_DECLINED: `Your refund was declined. Reason: ${refund.adminReason}`,
    REFUND_PROCESSING: 'Your accepted refund is being processed.',
    REFUND_INITIATED: 'Your refund has been initialized and is expected to be credited within 3–5 business days.',
  };
  await Notification.create({ userId: refund.userId, message: notifications[refund.status] || `Refund ${refund.refundCaseId} status changed.` });
  return res.json({ refund });
});

app.patch('/api/admin/refunds/:id/amount', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  if (refund.status !== 'ORDER_ACCEPTED') return res.status(409).json({ message: 'The approved amount can only be changed after inspection and before processing.' });
  const amountPaise = Number(req.body?.amountPaise);
  const maximum = refund.calculatedRefundAmountPaise ?? refund.refundAmountPaise;
  const original = refund.originalOrderAmountPaise ?? maximum;
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > maximum || amountPaise > original) {
    return res.status(400).json({ message: 'Approved refund must be a positive amount no greater than the eligible refund.' });
  }
  const previousAmount = refund.approvedRefundAmountPaise ?? refund.refundAmountPaise;
  refund.approvedRefundAmountPaise = amountPaise;
  refund.refundAmountPaise = amountPaise;
  refund.adminAudit.push({ adminId: req.session.email, action: 'refund_amount_changed', timestamp: new Date(), oldStatus: refund.status, newStatus: refund.status, amountPaise, reason: `Changed from ${money(previousAmount)} to ${money(amountPaise)}.` });
  refund.statusHistory.push({ status: refund.status, changedBy: req.session.email, note: `Approved refund amount set to ₹${money(amountPaise).toLocaleString('en-IN')}.`, createdAt: new Date() });
  await refund.save();
  return res.json({ refund });
});

app.post('/api/admin/refunds/:id/initiate', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) return res.status(404).json({ message: 'Refund case was not found.' });
  if (refund.status !== 'REFUND_PROCESSING') return res.status(409).json({ message: 'This refund is not ready to initialize.' });
  setRefundStatus(refund, 'REFUND_INITIATED', req.session.email, 'Refund initialized; expected wallet credit within 3–5 business days.', 'refund_initiated');
  await refund.save();
  await Notification.create({ userId: refund.userId, message: 'Your refund has been initialized and is expected to be credited within 3–5 business days.' });
  return res.json({ refund });
});

app.post('/api/admin/refunds/:id/credit', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  try {
    const result = await withMongoTransaction(async (session) => {
      const refund = await Refund.findById(req.params.id).session(session);
      if (!refund) throw Object.assign(new Error('Refund case was not found.'), { status: 404 });
      if (['REFUND_CREDITED', 'REFUND_COMPLETED'].includes(refund.status)) return { refund: refund.toObject(), duplicate: true };
      if (refund.status !== 'REFUND_INITIATED') throw Object.assign(new Error('Only an initialized refund can be credited.'), { status: 409 });
      const approvedAmount = refund.approvedRefundAmountPaise ?? refund.refundAmountPaise;
      const maximum = refund.calculatedRefundAmountPaise ?? refund.originalOrderAmountPaise ?? approvedAmount;
      if (!Number.isSafeInteger(approvedAmount) || approvedAmount <= 0 || approvedAmount > maximum || approvedAmount > (refund.originalOrderAmountPaise ?? maximum)) {
        throw Object.assign(new Error('The approved refund amount is not valid.'), { status: 409 });
      }
      const referenceId = `refund:${refund.refundCaseId}`;
      const existingTransaction = await WalletTransaction.findOne({ referenceId }).session(session);
      if (existingTransaction) throw Object.assign(new Error('This refund has already been credited.'), { status: 409 });
      const wallet = await Wallet.findOne({ userId: refund.userId }).session(session);
      if (!wallet) throw Object.assign(new Error('The customer has not created a wallet.'), { status: 409 });
      const before = wallet.balancePaise;
      wallet.balancePaise += approvedAmount;
      await wallet.save({ session });
      const [transaction] = await WalletTransaction.create([{
        userId: refund.userId,
        type: 'Refund',
        amountPaise: approvedAmount,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        orderId: refund.orderId,
        refundCaseId: refund.refundCaseId,
        description: `Refund ${refund.refundCaseId} for order ${refund.orderId}`,
        status: 'Completed',
      }], { session });
      refund.walletTransactionId = transaction._id;
      setRefundStatus(refund, 'REFUND_CREDITED', req.session.email, 'Refund credited to the customer wallet.', 'refund_credited');
      setRefundStatus(refund, 'REFUND_COMPLETED', req.session.email, 'Refund completed.', 'refund_completed');
      await refund.save({ session });
      const refundedOrder = await Order.findOne({ orderId: refund.orderId, userId: refund.userId }).session(session).lean();
      if (refundedOrder) {
        await reverseRewardPointsForOrder(session, refundedOrder, { referenceId, refundAmountPaise: approvedAmount });
        await releaseDiscountRedemptionForOrder(session, refundedOrder.orderId);
        await createCreditNoteForRefund(session, { userId: refund.userId, orderId: refund.orderId, refundCaseId: refund.refundCaseId, amountPaise: approvedAmount, reason: `Refund ${refund.refundCaseId}` });
      }
      await Notification.create([{ userId: refund.userId, message: `${money(approvedAmount).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })} has been credited to your Innovation Labs Wallet for refund ${refund.refundCaseId}.` }], { session });
      return { refund: refund.toObject(), balance: wallet.balancePaise, duplicate: false };
    });
    return res.json({ refund: result.refund, wallet: result.balance == null ? undefined : { balance: money(result.balance) }, duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This refund has already been credited.' });
    throw error;
  }
});

app.get('/api/scratch-cards', requireSession, requireDatabase, async (req, res) => {
  const cards = await ScratchCard.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean();
  const purchases = await PurchasedDiscountCode.find({ purchaseId: { $in: cards.map((card) => card.discountPurchaseId) } }).lean();
  const purchasesById = new Map(purchases.map((purchase) => [purchase.purchaseId, purchase]));
  return res.json({ scratchCards: cards.map((card) => {
    const reward = purchasesById.get(card.discountPurchaseId);
    const revealed = card.status !== 'issued' && reward?.fulfillmentStatus === 'fulfilled';
    return {
      scratchCardId: card.scratchCardId,
      orderId: card.orderId,
      eligibleOrderAmount: money(card.eligibleOrderAmountPaise),
      rewardValue: money(card.rewardValuePaise),
      rewardType: reward?.discountType || 'fixed',
      status: card.status,
      createdAt: card.createdAt,
      revealedAt: card.revealedAt || null,
      code: revealed ? reward.code : null,
    };
  }) });
});

app.post('/api/scratch-cards/:scratchCardId/reveal', requireSession, requireDatabase, async (req, res) => {
  try {
    const result = await withMongoTransaction(async (session) => {
      const card = await ScratchCard.findOne({ scratchCardId: req.params.scratchCardId, userId: req.session.sub }).session(session);
      if (!card) throw Object.assign(new Error('Scratch card was not found.'), { status: 404 });
      if (card.status === 'reversed') throw Object.assign(new Error('This scratch card is no longer valid.'), { status: 409 });
      const purchase = await PurchasedDiscountCode.findOne({ purchaseId: card.discountPurchaseId, userId: req.session.sub }).session(session);
      if (!purchase || !purchase.isScratchReward) throw Object.assign(new Error('Scratch card reward could not be verified.'), { status: 409 });
      if (card.status === 'issued') {
        if (purchase.expiresAt <= new Date()) throw Object.assign(new Error('This scratch card reward has expired.'), { status: 410 });
        card.status = 'scratched';
        card.revealedAt = new Date();
        purchase.fulfillmentStatus = 'fulfilled';
        await card.save({ session });
        await purchase.save({ session });
        const rewardLabel = purchase.discountType === 'percentage' ? `${purchase.discountPercent}% off` : `₹${money(card.rewardValuePaise)} off`;
        await Notification.create([{ userId: req.session.sub, type: 'scratch_card_revealed', data: { scratchCardId: card.scratchCardId, code: purchase.code }, message: `Scratch card revealed: ${purchase.code} gives ${rewardLabel}.` }], { session });
      }
      return { card: card.toObject(), purchase: purchase.toObject() };
    });
    return res.json({ scratchCard: {
      scratchCardId: result.card.scratchCardId,
      orderId: result.card.orderId,
      rewardValue: money(result.card.rewardValuePaise),
      rewardType: result.purchase.discountType,
      status: result.card.status,
      revealedAt: result.card.revealedAt,
      code: result.purchase.code,
    } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

app.get('/api/invoices', requireSession, requireDatabase, async (req, res) => {
  const invoices = await Invoice.find({ userId: req.session.sub }).sort({ createdAt: -1 }).select('-pdfData').lean();
  return res.json({ invoices });
});

app.get('/api/invoices/:invoiceId/download', requireSession, requireDatabase, async (req, res) => {
  const invoice = await Invoice.findOne({ userId: req.session.sub, $or: [{ invoiceId: req.params.invoiceId }, { invoiceNumber: req.params.invoiceId }] }).select('+pdfData');
  if (!invoice?.pdfData) return res.status(404).json({ message: 'Invoice PDF was not found.' });
  if (!Buffer.isBuffer(invoice.pdfData) || invoice.pdfData.length < 5 || invoice.pdfData.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(500).json({ message: 'The stored invoice PDF is invalid.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  return res.send(invoice.pdfData);
});

app.get('/api/account', requireSession, requireDatabase, async (req, res) => {
  const [user, orders, customOrders, notifications, refunds, subscriptionTransactions, billPurchases, creditPurchases] = await Promise.all([
    User.findOne({ googleId: req.session.sub }).lean(),
    Order.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    CustomOrder.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Notification.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Refund.find({ userId: req.session.sub }).select('orderId refundCaseId status originalOrderAmountPaise calculatedRefundAmountPaise refundAmountPaise approvedRefundAmountPaise reasonCategory walletTransactionReferenceId refundTransactionReferenceId originalPaymentMethod originalPaymentReference verifiedAmountPaidPaise refundDestination refundCreatedAt refundCompletedAt').lean(),
    SubscriptionTransaction.find({ userId: req.session.sub, status: 'Successful' }).sort({ createdAt: -1 }).lean(),
    AIBillPurchase.find({ userId: req.session.sub, status: 'completed' }).sort({ createdAt: -1 }).lean(),
    CreditPurchase.find({ userId: req.session.sub, status: 'completed' }).sort({ createdAt: -1 }).lean(),
  ]);
  const discountOrderIds = orders.filter((order) => order.orderType === 'DISCOUNT_CODE').map((order) => order.orderId);
  const discountPurchases = discountOrderIds.length
    ? await PurchasedDiscountCode.find({ orderId: { $in: discountOrderIds } }).select('orderId offerId fulfillmentStatus redemptionCount').lean()
    : [];
  const discountPurchasesByOrder = new Map();
  for (const purchase of discountPurchases) {
    const purchases = discountPurchasesByOrder.get(purchase.orderId) || [];
    purchases.push(purchase);
    discountPurchasesByOrder.set(purchase.orderId, purchases);
  }
  const productIds = [...new Set(orders.flatMap((order) => (order.items || [])
    .filter((item) => !item.customOrderId && !item.discountOfferId)
    .map((item) => String(item.id))))];
  const inventoryImages = productIds.length
    ? await InventoryItem.find({ productId: { $in: productIds } }).select('productId images').lean()
    : [];
  const imageByProductId = new Map(inventoryImages.map((item) => [String(item.productId), item.images?.[0] || null]));
  const refundsByOrder = new Map(refunds.map((refund) => [refund.orderId, refund]));
  const serverNow = new Date();
  const ordersWithRefundEligibility = orders.map((order) => {
    const safeOrderView = buyerOrderView(order);
    const refund = refundsByOrder.get(order.orderId) || null;
    const eligibility = refundEligibilityFor(order, refund);
    const hasUnusedDiscountCodePurchases = orderDiscountCodePurchasesAreUnused(order, discountPurchasesByOrder.get(order.orderId) || []);
    const cancellation = cancellationEligibilityFor(order, hasUnusedDiscountCodePurchases, serverNow);
    const arrived = orderHasArrived(order, serverNow);
    const partiallyCancelled = (safeOrderView.items || []).some((item) => Number(item.cancelledQuantity || 0) > 0)
      && (safeOrderView.items || []).some((item) => Number(item.quantity || 0) > Number(item.cancelledQuantity || 0));
    const cancelled = safeOrderView.orderStatus === 'Declined'
      || safeOrderView.allItemsCancelled
      || safeOrderView.orderStatus === 'Cancelled' && !partiallyCancelled
      || Boolean(order.cancelledAt) && !partiallyCancelled;
    return {
      ...safeOrderView,
      items: (safeOrderView.items || []).map((item) => ({
        ...item,
        image: item.image || item.images?.[0] || imageByProductId.get(String(item.id)) || null,
      })),
      estimatedDelivery: order.estimatedDelivery || null,
      arrived,
      deliveryBanner: cancelled ? 'ORDER CANCELLED' : arrived ? 'ARRIVED' : null,
      cancelEligible: cancellation.eligible,
      cancellationEligibility: { eligible: cancellation.eligible, reason: cancellation.reason },
      refundEligible: eligibility.eligible,
      refundEligibility: { eligible: eligibility.eligible, reason: eligibility.reason, deliveredAt: eligibility.deliveredAt, eligibleAt: eligibility.eligibleAt },
      refundCase: refund ? {
        _id: refund._id,
        refundCaseId: refund.refundCaseId,
        status: refund.status,
        originalOrderAmountPaise: refund.originalOrderAmountPaise,
        calculatedRefundAmountPaise: refund.calculatedRefundAmountPaise,
        refundAmountPaise: refund.refundAmountPaise,
        approvedRefundAmountPaise: refund.approvedRefundAmountPaise,
        reasonCategory: refund.reasonCategory,
        walletTransactionReferenceId: refund.walletTransactionReferenceId,
        refundTransactionReferenceId: refund.refundTransactionReferenceId,
        originalPaymentMethod: refund.originalPaymentMethod,
        originalPaymentReference: refund.originalPaymentReference,
        verifiedAmountPaidPaise: refund.verifiedAmountPaidPaise,
        refundDestination: refund.refundDestination,
        refundCreatedAt: refund.refundCreatedAt,
        refundCompletedAt: refund.refundCompletedAt,
      } : null,
    };
  });
  const seenSubscriptionIds = new Set();
  const subscriptionOrders = [...subscriptionTransactions].reverse().map((transaction) => {
    const startDate = transaction.startDate || transaction.createdAt;
    const expiryDate = transaction.expiryDate || addMonths(startDate, transaction.durationMonths || 1);
    const subscriptionId = transaction.subscriptionId ? String(transaction.subscriptionId) : '';
    const inferredRenewal = Boolean(subscriptionId && seenSubscriptionIds.has(subscriptionId));
    if (subscriptionId) seenSubscriptionIds.add(subscriptionId);
    return {
      id: transaction.orderId || `SUB-${transaction.paymentReference}`,
      orderId: transaction.orderId || `SUB-${transaction.paymentReference}`,
      orderCategory: 'SUBSCRIPTION_ORDER',
      orderType: 'SUBSCRIPTION',
      transactionType: transaction.transactionType || (inferredRenewal ? 'renewal' : 'purchase'),
      userName: user?.name || req.session.name || 'Customer',
      userEmail: user?.email || req.session.email,
      email: user?.email || req.session.email,
      plan: transaction.plan,
      durationMonths: transaction.durationMonths || 1,
      creditsAllocated: Number.isSafeInteger(transaction.creditsAllocated)
        ? transaction.creditsAllocated
        : (planConfig[transaction.plan]?.credits || 0) * (transaction.durationMonths || 1),
      billsAllocated: Number.isSafeInteger(transaction.billsAllocated)
        ? transaction.billsAllocated
        : getAiMonthlyAllowanceForPlan(transaction.plan) * (transaction.durationMonths || 1),
      paymentReference: transaction.paymentReference,
      paymentMethod: transaction.paymentMethod,
      paymentStatus: 'Successful',
      total: money(transaction.amountPaise),
      createdAt: transaction.createdAt,
      startDate,
      expiryDate,
      subscriptionStatus: expiryDate > serverNow ? 'Active' : 'Expired',
      orderStatus: expiryDate > serverNow ? 'Active' : 'Expired',
      deliveryRequired: false,
      items: [],
      cancelEligible: false,
      refundEligible: false,
    };
  }).reverse();
  const subscriptionAddOnOrders = [
    ...billPurchases.map((purchase) => ({
      id: `BILL-${purchase.purchaseId}`,
      orderId: `BILL-${purchase.purchaseId}`,
      orderCategory: 'SUBSCRIPTION_ORDER',
      orderType: 'SUBSCRIPTION',
      transactionType: 'bill_purchase',
      subscriptionName: 'AI Bill Credits',
      userName: user?.name || req.session.name || 'Customer',
      userEmail: user?.email || req.session.email,
      email: user?.email || req.session.email,
      plan: purchase.subscriptionDiscountPlan || 'Starter',
      quantity: purchase.quantity,
      creditsDeducted: purchase.creditsDeducted || 0,
      total: money(purchase.totalAmountPaise),
      paymentReference: purchase.paymentReference,
      paymentMethod: purchase.paymentMethod,
      paymentStatus: 'Successful',
      createdAt: purchase.createdAt,
      subscriptionStatus: 'Completed',
      orderStatus: 'Completed',
      deliveryRequired: false,
      items: [],
      cancelEligible: false,
      refundEligible: false,
    })),
    ...creditPurchases.map((purchase) => ({
      id: `CREDIT-${purchase.purchaseId}`,
      orderId: `CREDIT-${purchase.purchaseId}`,
      orderCategory: 'SUBSCRIPTION_ORDER',
      orderType: 'SUBSCRIPTION',
      transactionType: 'credit_purchase',
      subscriptionName: 'AI Credits',
      userName: user?.name || req.session.name || 'Customer',
      userEmail: user?.email || req.session.email,
      email: user?.email || req.session.email,
      plan: purchase.authorizedPlan || 'Exclusive',
      creditsAllocated: purchase.credits,
      total: money(purchase.totalAmountPaise),
      paymentReference: purchase.razorpayPaymentId || purchase.walletTransactionId || purchase.purchaseId,
      paymentMethod: purchase.paymentMethod,
      paymentStatus: 'Successful',
      createdAt: purchase.completedAt || purchase.createdAt,
      subscriptionStatus: 'Completed',
      orderStatus: 'Completed',
      deliveryRequired: false,
      items: [],
      cancelEligible: false,
      refundEligible: false,
    })),
  ];
  const combinedOrders = [...ordersWithRefundEligibility, ...subscriptionOrders, ...subscriptionAddOnOrders]
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
  const totalItemsOrdered = orders.reduce((sum, order) =>
    sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), subscriptionOrders.length + subscriptionAddOnOrders.length);
  const totalSpent = orders.reduce((sum, order) => sum + order.total, 0)
    + subscriptionTransactions.reduce((sum, transaction) => sum + money(transaction.amountPaise), 0)
    + billPurchases.reduce((sum, purchase) => sum + money(purchase.totalAmountPaise), 0)
    + creditPurchases.reduce((sum, purchase) => sum + money(purchase.totalAmountPaise), 0);

  return res.json({
    serverNow: serverNow.toISOString(),
    profile: {
      id: req.session.sub,
      name: user?.name || req.session.name,
      email: user?.email || req.session.email,
      picture: user?.picture || null,
      phoneNumber: user?.phoneNumber || '',
      address: user?.address || null,
      recipientAddresses: user?.recipientAddresses || [],
    },
    orders: combinedOrders,
    customOrders,
    notifications,
    stats: {
      totalOrders: combinedOrders.length,
      totalItemsOrdered,
      totalSpent,
      customOrderCount: customOrders.length,
    },
  });
});

app.get('/api/rewards', requireSession, requireDatabase, async (req, res) => {
  const [account, transactions] = await Promise.all([
    RewardAccount.findOneAndUpdate(
      { userId: req.session.sub },
      { $setOnInsert: { userId: req.session.sub } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ),
    RewardTransaction.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(250).lean(),
  ]);
  return res.json({
    account: {
      availablePoints: Math.max(0, account.availablePoints),
      lifetimePointsEarned: account.lifetimePointsEarned,
      lifetimePointsRedeemed: account.lifetimePointsRedeemed,
    },
    transactions,
  });
});

app.post('/api/rewards/convert', requireSession, requireDatabase, async (req, res) => {
  const pointsToConvert = Number(req.body?.pointsToConvert);
  const idempotencyKey = req.body?.idempotencyKey;
  const conversionType = req.body?.conversionType || 'wallet';
  if (!Number.isSafeInteger(pointsToConvert) || pointsToConvert < 100 || pointsToConvert % 100 !== 0 || pointsToConvert > 100000000 || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: 'Choose a valid conversion in multiples of 100 points.' });
  }
  if (!['wallet', 'discount-code'].includes(conversionType)) return res.status(400).json({ message: 'Choose a valid reward conversion type.' });
  const transactionId = `${conversionType === 'discount-code' ? 'discount-code' : 'convert'}:${idempotencyKey}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const previous = await RewardTransaction.findOne({ transactionId, userId: req.session.sub }).session(session).lean();
      if (previous) {
        const account = await RewardAccount.findOne({ userId: req.session.sub }).session(session).lean();
        if (conversionType === 'discount-code') {
          const scratchCard = await ScratchCard.findOne({ userId: req.session.sub, orderId: `REWARD-${transactionId}` }).session(session).lean();
          return { previous, account, scratchCard, duplicate: true };
        }
        const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session).lean();
        return { previous, account, wallet, duplicate: true };
      }
      const account = await RewardAccount.findOneAndUpdate(
        { userId: req.session.sub, availablePoints: { $gte: pointsToConvert } },
        { $inc: { availablePoints: -pointsToConvert, lifetimePointsRedeemed: pointsToConvert } },
        { new: true, session },
      );
      if (!account) throw Object.assign(new Error('You need at least 100 available points and cannot convert more than your balance.'), { status: 409 });
      if (conversionType === 'discount-code') {
        const settings = await ScratchSettings.findOne({ key: 'default' }).session(session).lean() || defaultScratchSettings;
        const scratchCard = await createScratchCardReward(session, {
          userId: req.session.sub,
          orderId: `REWARD-${transactionId}`,
          eligibleOrderAmountPaise: 0,
          rewardValue: pointsToConvert * 100,
          rewardType: 'fixed',
          settings,
        });
        const [transaction] = await RewardTransaction.create([{
          transactionId,
          userId: req.session.sub,
          userEmail: req.session.email,
          transactionType: 'redeemed',
          productType: 'Scratch Card Discount Code',
          eligibleAmountPaise: 0,
          points: pointsToConvert,
          walletAmountPaise: 0,
          status: 'redeemed',
        }], { session });
        return { previous: transaction.toObject(), account: account.toObject(), scratchCard, duplicate: false };
      }
      const walletAmountPaise = pointsToConvert * 100;
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session)
        || new Wallet({ userId: req.session.sub });
      const balanceBeforePaise = wallet.balancePaise;
      wallet.balancePaise += walletAmountPaise;
      await wallet.save({ session });
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Reward Points',
        amountPaise: walletAmountPaise,
        balanceBeforePaise,
        balanceAfterPaise: wallet.balancePaise,
        referenceId: `reward-wallet:${idempotencyKey}`,
        description: `Converted ${pointsToConvert} reward points to Wallet money`,
        status: 'Successful',
      }], { session });
      const [transaction] = await RewardTransaction.create([{
        transactionId,
        userId: req.session.sub,
        userEmail: req.session.email,
        transactionType: 'redeemed',
        productType: 'Wallet conversion',
        eligibleAmountPaise: 0,
        points: pointsToConvert,
        walletAmountPaise,
        status: 'redeemed',
      }], { session });
      return { previous: transaction.toObject(), account: account.toObject(), wallet: wallet.toObject(), duplicate: false };
    });
    return res.json({
      transaction: result.previous,
      account: {
        availablePoints: Math.max(0, result.account?.availablePoints || 0),
        lifetimePointsEarned: result.account?.lifetimePointsEarned || 0,
        lifetimePointsRedeemed: result.account?.lifetimePointsRedeemed || 0,
      },
      ...(conversionType === 'discount-code' ? { scratchCard: result.scratchCard ? {
        scratchCardId: result.scratchCard.scratchCardId,
        rewardValue: money(result.scratchCard.rewardValuePaise),
        rewardType: result.scratchCard.rewardType,
        status: result.scratchCard.status,
      } : null } : { wallet: { balance: money(walletAvailableBalancePaise(result.wallet)) } }),
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) {
      const previous = await RewardTransaction.findOne({ transactionId, userId: req.session.sub }).lean();
      if (previous) {
        const account = await RewardAccount.findOne({ userId: req.session.sub }).lean();
        if (conversionType === 'discount-code') {
          const scratchCard = await ScratchCard.findOne({ userId: req.session.sub, orderId: `REWARD-${transactionId}` }).lean();
          return res.json({
            transaction: previous,
            account: {
              availablePoints: Math.max(0, account?.availablePoints || 0),
              lifetimePointsEarned: account?.lifetimePointsEarned || 0,
              lifetimePointsRedeemed: account?.lifetimePointsRedeemed || 0,
            },
            scratchCard: scratchCard ? {
              scratchCardId: scratchCard.scratchCardId,
              rewardValue: money(scratchCard.rewardValuePaise),
              rewardType: scratchCard.rewardType,
              status: scratchCard.status,
            } : null,
            duplicate: true,
          });
        }
        const wallet = await Wallet.findOne({ userId: req.session.sub }).lean();
        return res.json({
          transaction: previous,
          account: {
            availablePoints: Math.max(0, account?.availablePoints || 0),
            lifetimePointsEarned: account?.lifetimePointsEarned || 0,
            lifetimePointsRedeemed: account?.lifetimePointsRedeemed || 0,
          },
          wallet: { balance: money(walletAvailableBalancePaise(wallet)) },
          duplicate: true,
        });
      }
      return res.status(409).json({ message: 'This reward conversion has already been processed.' });
    }
    throw error;
  }
});

app.put('/api/account/address', requireSession, requireDatabase, async (req, res) => {
  const address = req.body?.address;
  if (!validateAddress(address)) {
    return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  }
  const user = await User.findOneAndUpdate(
    { googleId: req.session.sub },
    { $set: { address } },
    { new: true },
  ).lean();
  if (!user) return res.sendStatus(404);
  return res.json({ address: user.address });
});

app.post('/api/account/recipient-addresses', requireSession, requireDatabase, async (req, res) => {
  const address = req.body?.address;
  if (!validateAddress(address)) {
    return res.status(400).json({ message: 'Complete the required recipient address fields.' });
  }
  const fields = ['fullName', 'phoneNumber', 'addressLine1', 'addressLine2', 'city', 'state', 'pinCode', 'country', 'deliveryInstructions'];
  const recipientAddress = Object.fromEntries(fields
    .filter((field) => typeof address[field] === 'string')
    .map((field) => [field, address[field].trim().slice(0, field === 'deliveryInstructions' ? 500 : 200)]));
  const user = await User.findOne({ googleId: req.session.sub });
  if (!user) return res.sendStatus(404);
  const identity = (value) => fields.map((field) => String(value?.[field] || '').trim().toLowerCase()).join('\u0000');
  const existing = user.recipientAddresses || [];
  const addressIndex = existing.findIndex((saved) => identity(saved) === identity(recipientAddress));
  if (addressIndex >= 0) {
    existing.splice(addressIndex, 1);
  }
  user.recipientAddresses = [recipientAddress, ...existing].slice(0, 50);
  await user.save();
  return res.json({ recipientAddresses: user.recipientAddresses });
});

app.patch('/api/account/settings', requireSession, requireDatabase, async (req, res) => {
  const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : null;
  if (phoneNumber === null || phoneNumber.length > 30) {
    return res.status(400).json({ message: 'Enter a valid phone number.' });
  }
  const user = await User.findOneAndUpdate(
    { googleId: req.session.sub },
    { $set: { phoneNumber } },
    { new: true },
  ).lean();
  if (!user) return res.sendStatus(404);
  return res.json({ phoneNumber: user.phoneNumber || '' });
});

app.patch('/api/notifications/:id/read', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Notification was not found.' });
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.session.sub },
    { $set: { read: true } },
    { new: true },
  ).lean();
  if (!notification) return res.sendStatus(404);
  return res.json({ notification });
});

app.get('/api/orders/:orderId', requireSession, requireDatabase, async (req, res) => {
  const query = { userId: req.session.sub };
  const lookups = [{ orderId: req.params.orderId }];
  if (mongoose.isValidObjectId(req.params.orderId)) lookups.push({ _id: req.params.orderId });
  const order = await Order.findOne({ ...query, $or: lookups }).lean();
  if (!order) return res.status(404).json({ message: 'Order was not found.' });
  return res.json({ order: buyerOrderView(order) });
});

app.post('/api/orders/:orderId/cancellation-quote', requireSession, requireDatabase, async (req, res) => {
  const requestedItems = req.body?.items;
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 50
    || requestedItems.some((item) => !Number.isSafeInteger(item?.itemIndex) || item.itemIndex < 0
      || !Number.isSafeInteger(item?.quantity) || item.quantity < 1)) {
    return res.status(400).json({ message: 'Select at least one valid product and quantity to cancel.' });
  }
  try {
    const order = await Order.findOne({ orderId: req.params.orderId, userId: req.session.sub }).lean();
    if (!order) return res.status(404).json({ message: 'Order was not found.' });
    const discountPurchases = order.orderType === 'DISCOUNT_CODE'
      ? await PurchasedDiscountCode.find({ orderId: order.orderId }).lean()
      : [];
    const eligibility = cancellationEligibilityFor(order, orderDiscountCodePurchasesAreUnused(order, discountPurchases));
    if (!eligibility.eligible) return res.status(409).json({ message: eligibility.reason });
    const selectedItems = resolveCancellationItems(order, requestedItems);
    if (order.orderType === 'DISCOUNT_CODE'
      && selectedItems.reduce((sum, selected) => sum + selected.quantity, 0)
        !== (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)) {
      return res.status(409).json({ message: 'Discount Promo Code orders must be cancelled in full.' });
    }
    const quote = calculateCancellationRefund(order, selectedItems);
    return res.json({
      orderId: order.orderId,
      items: selectedItems.map(({ item, quantity }) => ({
        name: item.name,
        quantity,
        amount: money(Number(item.unitPricePaise ?? toPaise(item.price)) * quantity),
      })),
      nonCancellableItems: (order.items || []).map((item, itemIndex) => ({
        itemIndex,
        name: item.name,
        quantity: Math.max(0, Number(item.quantity || 0) - Number(item.cancelledQuantity || 0)),
      })).filter((item) => item.quantity > 0 && order.items[item.itemIndex].cancellable === false),
      originalAmount: money(quote.originalAmountPaise),
      originalAmountPaise: quote.originalAmountPaise,
      nonRefundableCharges: {
        delivery: money(toPaise(order.deliveryCharge || 0)),
        coding: money(toPaise(order.codingCharge || 0)),
        building: money(toPaise(order.buildingCharge || 0)),
        total: money(quote.totalNonRefundableChargesPaise),
        deductedNow: money(quote.deductionsPaise),
        previouslyDeducted: money(quote.previouslyDeductedPaise),
      },
      discount: money(quote.allocatedDiscountPaise),
      estimatedRefund: money(quote.amountPaise),
      estimatedRefundPaise: quote.amountPaise,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

app.post('/api/orders/:orderId/cancel', requireSession, requireDatabase, async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  const idempotencyKey = typeof req.body?.idempotencyKey === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey
    : null;
  if (!reason) return res.status(400).json({ message: 'Choose a cancellation reason before continuing.' });
  if (!idempotencyKey) return res.status(400).json({ message: 'A valid cancellation request key is required.' });
  const requestedItems = req.body?.items;
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 50
    || requestedItems.some((item) => !Number.isSafeInteger(item?.itemIndex) || item.itemIndex < 0
      || !Number.isSafeInteger(item?.quantity) || item.quantity < 1)) {
    return res.status(400).json({ message: 'Select at least one valid product and quantity to cancel.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const order = await Order.findOne({ orderId: req.params.orderId, userId: req.session.sub }).session(session);
      if (!order) throw Object.assign(new Error('Order was not found.'), { status: 404 });
      const previousCancellation = (order.cancellationEvents || []).find((event) => event.idempotencyKey === idempotencyKey);
      if (previousCancellation) {
        await syncWalletRestrictionState(req.session.sub, session);
        const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
        const walletPlanState = await getWalletLimitStatus(req.session.sub, wallet?.balancePaise || 0, session);
        return {
          order: order.toObject(),
          cancellationId: previousCancellation.cancellationId,
          amountPaise: previousCancellation.refundAmountPaise || 0,
          deductionsPaise: previousCancellation.deductionsPaise || 0,
          wallet: wallet ? walletView(wallet.toObject(), [], walletPlanState) : null,
          cancelledItems: previousCancellation.items || [],
          complete: Boolean(previousCancellation.complete),
          duplicate: true,
        };
      }
      const orderValue = order.toObject();
      const discountPurchases = order.orderType === 'DISCOUNT_CODE'
        ? await PurchasedDiscountCode.find({ orderId: order.orderId }).session(session).lean()
        : [];
      const hasUnusedDiscountCodePurchases = orderDiscountCodePurchasesAreUnused(orderValue, discountPurchases);
      const eligibility = cancellationEligibilityFor(orderValue, hasUnusedDiscountCodePurchases);
      if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { status: 409 });
      const selectedItems = resolveCancellationItems(order, requestedItems);
      if (order.orderType === 'DISCOUNT_CODE'
        && selectedItems.reduce((sum, selected) => sum + selected.quantity, 0)
          !== (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)) {
        throw Object.assign(new Error('Discount Promo Code orders must be cancelled in full.'), { status: 409 });
      }
      if (order.orderType === 'DISCOUNT_CODE') {
        const revoked = await PurchasedDiscountCode.updateMany(
          { orderId: order.orderId, fulfillmentStatus: 'fulfilled', redemptionCount: 0 },
          { $set: { fulfillmentStatus: 'rejected' } },
          { session },
        );
        if (revoked.modifiedCount !== discountPurchases.length) {
          throw Object.assign(new Error('This Discount Promo Code is no longer available for cancellation.'), { status: 409 });
        }
        const quantitiesByOffer = new Map();
        for (const purchase of discountPurchases) {
          const offerId = String(purchase.offerId);
          quantitiesByOffer.set(offerId, (quantitiesByOffer.get(offerId) || 0) + 1);
        }
        for (const [offerId, quantity] of quantitiesByOffer) {
          const restoredOffer = await DiscountCodeOffer.updateOne(
            { _id: offerId, purchasedCount: { $gte: quantity } },
            { $inc: { availableQuantity: quantity, purchasedCount: -quantity } },
            { session },
          );
          if (!restoredOffer.modifiedCount) {
            throw Object.assign(new Error('The Discount Promo Code inventory could not be restored.'), { status: 409 });
          }
        }
      }
      const selectedInventoryItems = selectedItems.map(({ item, quantity }) => ({ ...item.toObject(), quantity }));
      await restoreInventoryForItems(session, selectedInventoryItems);
      const refund = calculateCancellationRefund(orderValue, selectedItems);
      const { itemAmounts } = refund;
      const previouslyRefundedPaise = Number(order.cancellationRefundedPaise || 0);
      const { originalAmountPaise, totalNonRefundableChargesPaise, deductionsPaise, amountPaise } = refund;
      await syncWalletRestrictionState(req.session.sub, session);
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet) throw Object.assign(new Error('The Wallet used for this order could not be found.'), { status: 409 });
      const cancellationId = `CN-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const cancelledAt = new Date();
      let transaction = null;
      let updatedWallet = wallet.toObject();
      if (amountPaise > 0) {
        const balanceBeforePaise = wallet.balancePaise;
        wallet.balancePaise += amountPaise;
        await wallet.save({ session });
        updatedWallet = await syncWalletRestrictionState(req.session.sub, session);
        const balanceAfterPaise = Number(updatedWallet.balancePaise || 0);
        const availableBalanceAfterPaise = Number(updatedWallet.availableBalancePaise || 0);
        [transaction] = await WalletTransaction.create([{
          userId: req.session.sub,
          userEmail: order.userEmail,
          type: 'Refund',
          amountPaise,
          balanceBeforePaise,
          balanceAfterPaise,
          availableBalanceAfterPaise,
          referenceId: `cancellation:${cancellationId}`,
          orderId: order.orderId,
          cancellationId,
          cancellationSource: 'CUSTOMER',
          originalPaymentMethod: order.paymentMethod,
          originalPaymentReference: order.originalPaymentReference,
          refundDestination: 'Innovation Labs Wallet',
          refundDeductionsPaise: deductionsPaise,
          description: `Refund credited to Innovation Labs Wallet – ${order.orderId}`,
          status: 'Successful',
        }], { session });
      } else {
        updatedWallet = await syncWalletRestrictionState(req.session.sub, session);
      }
      for (const { itemIndex, quantity } of selectedItems) {
        const item = order.items[itemIndex];
        item.cancelledQuantity = Number(item.cancelledQuantity || 0) + quantity;
        if (!item.cancellations) item.cancellations = [];
        item.cancellations.push({
          cancellationId,
          quantity,
          reason,
          cancelledBy: req.session.sub,
          source: 'CUSTOMER',
          cancelledAt,
        });
        if (Number(item.cancelledQuantity || 0) >= Number(item.quantity || 0)) {
          item.fulfillmentStatus = 'Cancelled';
        }
      }
      const allItemsCancelled = (order.items || []).every((item) =>
        Number(item.cancelledQuantity || 0) >= Number(item.quantity || 0));
      if (allItemsCancelled) {
        order.orderStatus = 'Cancelled';
        order.cancelledAt = cancelledAt;
        order.cancellationId = cancellationId;
        order.cancellationIdempotencyKey = idempotencyKey;
      }
      order.cancellationReason = reason;
      order.cancellationType = 'CUSTOMER_REQUEST';
      order.cancellationSource = 'CUSTOMER';
      order.cancellationDeductionsPaise = Number(order.cancellationDeductionsPaise || 0) + deductionsPaise;
      order.cancelledBy = req.session.sub;
      order.cancellationRefundedPaise = previouslyRefundedPaise + amountPaise;
      order.cancellationRefundAmountPaise = order.cancellationRefundedPaise;
      if (transaction) {
        order.cancellationRefundTransactionId = transaction._id;
        order.refundTransactionReferenceId = transaction.referenceId;
        order.refundDestination = 'Innovation Labs Wallet';
        order.refundCreatedAt = cancelledAt;
        order.refundCompletedAt = cancelledAt;
      }
      if (amountPaise > 0) {
        order.refundAmountPaise = order.cancellationRefundedPaise;
        order.refundReason = reason;
        order.refundStatus = 'Completed';
      }
      order.cancellationBalanceAfterPaise = Number(updatedWallet.balancePaise || 0);
      order.cancellationEvents.push({
        cancellationId,
        idempotencyKey,
        reason,
        userEmail: order.userEmail,
        items: itemAmounts,
        originalAmountPaise,
        refundAmountPaise: amountPaise,
        deductionsPaise,
        totalNonRefundableChargesPaise,
        walletBalanceAfterPaise: Number(updatedWallet.balancePaise || 0),
        refundStatus: amountPaise > 0 ? 'Completed' : undefined,
        refundDestination: amountPaise > 0 ? 'Innovation Labs Wallet' : undefined,
        refundTransactionReferenceId: transaction?.referenceId,
        complete: allItemsCancelled,
        walletTransactionId: transaction?._id,
        createdAt: cancelledAt,
      });
      order.statusHistory.push({
        status: 'Customer Requested Cancellation',
        note: `Customer requested cancellation for ${itemAmounts.map((item) => `${order.items[item.itemIndex]?.name || 'item'} × ${item.quantity}`).join(', ')}.`,
        createdAt: cancelledAt,
      });
      order.statusHistory.push({
        status: allItemsCancelled ? 'Cancelled' : 'Items Cancelled',
        note: `${allItemsCancelled ? 'Order cancelled' : 'Eligible order items cancelled'} by customer. Refund ₹${money(amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })}; applicable non-refundable charges deducted ₹${money(deductionsPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })}. ${reason}`,
        createdAt: cancelledAt,
      });
      await order.save({ session });
      if (amountPaise > 0) {
        await reverseRewardPointsForOrder(session, order.toObject(), { referenceId: `cancellation:${cancellationId}`, refundAmountPaise: amountPaise });
        await createCreditNoteForRefund(session, { userId: order.userId, orderId: order.orderId, refundCaseId: `CN-${cancellationId}`, amountPaise, reason });
      }
      if (allItemsCancelled) await releaseDiscountRedemptionForOrder(session, order.orderId);
      const nonCancellableNames = (order.items || []).filter((item) => item.cancellable === false).map((item) => item.name);
      const mixedOrderNotice = nonCancellableNames.length
        ? ' Your order contains a non-cancellable product. Only eligible products can be cancelled. The amount for the non-cancellable product will not be refunded through customer-initiated cancellation.'
        : '';
      await Notification.create([{
        userId: req.session.sub,
        message: `Cancellation processed for order ${order.orderId}. ₹${money(amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was returned to your Wallet${deductionsPaise > 0 ? ` after ₹${money(deductionsPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} in applicable non-refundable charges` : ''}.${mixedOrderNotice}`,
      }], { session });
      return {
        order: order.toObject(),
        cancellationId,
        amountPaise,
        deductionsPaise,
        wallet: walletView(updatedWallet, [], await getWalletLimitStatus(req.session.sub, updatedWallet.balancePaise, session)),
        cancelledItems: itemAmounts,
        complete: allItemsCancelled,
        duplicate: false,
      };
    });
    return res.json({
      order: result.order,
      cancellation: {
        cancellationId: result.cancellationId,
        amount: money(result.amountPaise),
        deductions: money(result.deductionsPaise),
        reason: result.order.cancellationReason,
        items: result.cancelledItems,
        complete: result.complete,
      },
      wallet: result.wallet || { balance: 0, availableBalance: 0, totalBalance: 0, restrictedBalance: 0 },
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This cancellation has already been processed.' });
    throw error;
  }
});

app.post('/api/orders', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const { items, address, service = 'parts', projectDescription = '', razorpayId, discountCode, checkoutReference } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    return res.status(400).json({ message: 'The order must contain at least one item.' });
  }
  if (!['parts', 'coding', 'building', 'full'].includes(service)) return res.status(400).json({ message: 'Choose a valid project service.' });
  let resolved;
  try {
    resolved = await resolveOrderItems(items, req.session.sub);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message || 'An item in the cart is unavailable.' });
  }
  const { safeItems, customOrders } = resolved;
  const deliveryRequired = orderRequiresDelivery(safeItems);
  if (deliveryRequired && !validateAddress(address)) return res.status(400).json({ message: 'Complete the required delivery address fields.' });
  const calculated = calculateOrder(safeItems, service);
  const paymentId = typeof razorpayId === 'string' ? razorpayId.trim() : '';
  if (typeof checkoutReference !== 'string' || !checkoutReference.trim()) {
    return res.status(400).json({ message: 'A valid recorded checkout is required to place this order.' });
  }
  if (paymentId) {
    const alreadyPlaced = await Order.findOne({ razorpayId: paymentId }).lean();
    if (alreadyPlaced && alreadyPlaced.userId === req.session.sub && alreadyPlaced.checkoutReference === checkoutReference) {
      return res.json({
        order: { ...alreadyPlaced, discountCodes: await discountCodesForOrder(alreadyPlaced.orderId) },
        duplicate: true,
        notification: null,
      });
    }
    if (alreadyPlaced) return res.status(409).json({ message: 'This payment has already been linked to another order.' });
  }
  if (!paymentId) return res.status(400).json({ message: 'A verified Razorpay payment is required to place this order.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay payment verification is not configured.' });
  let paymentAmountPaise = 0;
  let paymentOrderId = '';
  let paymentVerified = false;
  try {
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
    });
    const payment = await paymentResponse.json();
    const confirmedAmountPaise = Number(payment.amount);
    if (!paymentResponse.ok || payment.currency !== 'INR' || payment.status !== 'captured' || !Number.isSafeInteger(confirmedAmountPaise) || confirmedAmountPaise < 0) {
      return res.status(409).json({ message: 'Payment amount or capture status could not be verified; no order or reward points were created.' });
    }
    paymentAmountPaise = confirmedAmountPaise;
    paymentOrderId = payment.order_id || '';
    paymentVerified = true;
  } catch {
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
  let discount = null;
  try {
    if (discountCode) discount = await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems });
  } catch (error) {
    try { await refundRazorpayPayment(paymentId, paymentAmountPaise); } catch (refundError) {
      return res.status(409).json({ message: `${error.message} Automatic refund failed: ${refundError.message}` });
    }
    return res.status(error.status || 409).json({ message: `${error.message} The captured payment was refunded.` });
  }
  const discountAmountPaise = discount?.discountAmountPaise || 0;
  const subscriptionDiscount = await subscriptionDiscountForAmount(
    req.session.sub,
    Math.max(0, calculated.totalPaise - discountAmountPaise),
  );
  let expectedCheckoutAmountPaise = null;
  if (checkoutReference) {
    const checkout = await CheckoutAttempt.findOne({
      reference: checkoutReference, userId: req.session.sub, status: 'Open',
    }).select('razorpayOrderId items service totalPaise').lean();
    if (!checkout || !checkout.razorpayOrderId || checkout.razorpayOrderId !== paymentOrderId
      || !Number.isSafeInteger(checkout.totalPaise)
      || !checkoutAttemptMatches(checkout, { items: safeItems, service, totalPaise: checkout.totalPaise })) {
      try {
        await refundRazorpayPayment(paymentId, paymentAmountPaise);
        await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: 'Open' },
          { $set: { status: 'Interrupted', paymentStatus: 'Failed', paymentReference: paymentId, reason: 'Captured payment was refunded because its order or checkout details did not match.' } },
        );
        await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: { $in: ['Interrupted', 'Explicitly Cancelled'] } },
          { $set: { paymentStatus: 'Failed', paymentReference: paymentId, reason: 'Captured payment was refunded because its order or checkout details did not match.' } },
        );
        return res.status(409).json({ message: 'Payment or checkout details did not match the recorded checkout. The captured payment was refunded.' });
      } catch (refundError) {
        await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: { $in: ['Open', 'Interrupted', 'Explicitly Cancelled'] } },
          { $set: { status: 'Payment Review', paymentStatus: 'Paid', paymentReference: paymentId, reason: `Unmatched payment; automatic refund failed: ${refundError.message}` } },
        );
        return res.status(409).json({ message: `Payment could not be matched or refunded: ${refundError.message}` });
      }
    }
    expectedCheckoutAmountPaise = checkout.totalPaise;
  }
  const expectedPaymentAmountPaise = expectedCheckoutAmountPaise ?? Math.max(0, calculated.totalPaise - discountAmountPaise - subscriptionDiscount.amountPaise);
  if (paymentAmountPaise !== expectedPaymentAmountPaise) {
    try { await refundRazorpayPayment(paymentId, paymentAmountPaise); } catch (refundError) {
      if (checkoutReference) await CheckoutAttempt.updateOne(
        { reference: checkoutReference, userId: req.session.sub, status: 'Open' },
        { $set: { status: 'Payment Review', paymentStatus: 'Paid', paymentReference: paymentId, reason: `Payment mismatch; automatic refund failed: ${refundError.message}` } },
      );
      return res.status(409).json({ message: `The captured amount did not match this order. Automatic refund failed: ${refundError.message}` });
    }
    if (checkoutReference) await CheckoutAttempt.updateOne(
      { reference: checkoutReference, userId: req.session.sub, status: 'Open' },
      { $set: { status: 'Interrupted', paymentStatus: 'Failed', paymentReference: paymentId, reason: 'Captured payment was refunded because its amount did not match the checkout.' } },
    );
    return res.status(409).json({ message: 'Payment amount did not match the recorded checkout amount; the captured payment was refunded.' });
  }
  if (checkoutReference) {
    const checkoutAttempt = await CheckoutAttempt.findOneAndUpdate(
      { reference: checkoutReference, userId: req.session.sub, status: 'Open' },
      { $set: { status: 'Completing', paymentStatus: 'Paid', paymentReference: paymentId } },
      { new: true },
    );
    if (!checkoutAttempt) {
      try {
        await refundRazorpayPayment(paymentId, paymentAmountPaise);
        return res.status(409).json({ message: 'Checkout was exited before payment completion. The captured payment was refunded.' });
      } catch (refundError) {
        await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: { $in: ['Explicitly Cancelled', 'Interrupted'] } },
          { $set: { status: 'Payment Review', paymentStatus: 'Paid', paymentReference: paymentId, reason: `Checkout ended during payment; automatic refund failed: ${refundError.message}` } },
        );
        return res.status(409).json({ message: `Checkout was exited, but the captured payment could not be refunded automatically: ${refundError.message}` });
      }
    }
  }
  const previouslyUsedPayment = await Order.findOne({ razorpayId: paymentId }).select('userId orderId checkoutReference').lean();
  if (previouslyUsedPayment && (previouslyUsedPayment.userId !== req.session.sub || previouslyUsedPayment.checkoutReference !== checkoutReference)) {
    return res.status(409).json({ message: 'This payment has already been linked to another order.' });
  }
  const orderId = `IL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const result = await withMongoTransaction(async (session) => {
      const existingOrder = paymentId
        ? await Order.findOne({ razorpayId: paymentId }).session(session).lean()
        : null;
      if (existingOrder && existingOrder.userId === req.session.sub && existingOrder.checkoutReference === checkoutReference) {
        return { order: existingOrder, notification: null, duplicate: true };
      }
      if (existingOrder) throw Object.assign(new Error('This payment has already been linked to another order.'), { status: 409, doNotRefund: true });
      await enforceOrderLimit(session);
      const currentSubscriptionDiscount = await subscriptionDiscountForAmount(
        req.session.sub,
        Math.max(0, calculated.totalPaise - discountAmountPaise),
        session,
      );
      if (paymentAmountPaise !== expectedPaymentAmountPaise) {
        throw Object.assign(new Error('The captured payment no longer matches the recorded checkout amount. The payment will be refunded.'), { status: 409 });
      }
      const inventoryDeductedAt = await applyInventoryReduction(session, safeItems, { validateProductSnapshot: true });
      const [order] = await Order.create([{
        orderId,
        orderType: safeItems.every((item) => item.discountOfferId) ? 'DISCOUNT_CODE' : 'PRODUCT',
        userId: req.session.sub,
        userName: req.session.name || req.session.email.split('@')[0],
        userEmail: req.session.email,
        items: orderItemsSnapshot(safeItems),
        address: deliveryRequired ? address : null,
        deliveryRequired,
        service,
        projectDescription: String(projectDescription).slice(0, 2000),
        subtotal: money(calculated.subtotalPaise),
        discountAmountPaise,
        discountCode: discount?.code || '',
        subscriptionDiscountAmountPaise: currentSubscriptionDiscount.amountPaise,
        subscriptionDiscountPlan: currentSubscriptionDiscount.plan,
        subscriptionDiscountPercent: currentSubscriptionDiscount.percentage,
        codingCharge: money(calculated.codingChargePaise),
        buildingCharge: money(calculated.buildingChargePaise),
        deliveryCharge: money(calculated.deliveryChargePaise),
        total: money(expectedPaymentAmountPaise),
        paymentStatus: 'Paid',
        paymentMethod: 'Razorpay',
        verifiedAmountPaidPaise: paymentAmountPaise,
        paymentVerifiedAt: new Date(),
        originalPaymentReference: paymentId,
        inventoryDeductedAt,
        orderStatus: 'Processing',
        statusHistory: [{ status: 'Processing', note: 'Order created', createdAt: new Date() }],
        razorpayId: paymentId,
        checkoutReference: checkoutReference || undefined,
      }], { session });
      const discountCodes = await fulfillDiscountOfferItems(session, safeItems, { userId: req.session.sub, orderId });
      if (discount) {
        const redeemed = await redeemDiscountCode(session, { userId: req.session.sub, code: discount.code, items: safeItems, orderId });
        if (redeemed.discountAmountPaise !== discountAmountPaise) throw Object.assign(new Error('The discount changed during payment; the order was not committed.'), { status: 409 });
      }
      await awardRewardPointsForOrder(session, order);
      await createInvoiceForOrder(session, order);
      await createScratchCardForOrder(session, order);
      if (customOrders.length) {
        await CustomOrder.updateMany(
          { _id: { $in: customOrders.map((customOrder) => customOrder._id) }, userId: req.session.sub, status: 'Accepted' },
          { $set: { status: 'Ordered', orderedAt: new Date() } },
          { session },
        );
      }
      const [notification] = await Notification.create([{
        userId: req.session.sub,
        message: `Order ${orderId} was placed successfully.`,
      }], { session });
      if (checkoutReference) {
        const checkoutAttempt = await CheckoutAttempt.findOneAndUpdate(
          { reference: checkoutReference, userId: req.session.sub, status: 'Completing', paymentStatus: 'Paid' },
          { $set: { status: 'Completed', completedAt: new Date() } },
          { new: true, session },
        );
        if (!checkoutAttempt) throw Object.assign(new Error('Checkout could not be completed safely.'), { status: 409 });
      }
      const cartItems = checkoutReference
        ? await removeOrderedItemsFromCart(session, req.session.sub, order.items)
        : null;
      return { order, discountCodes, notification, duplicate: false, cartItems };
    });
    const savedOrder = result.order.toObject ? result.order.toObject() : result.order;
    if (result.cartItems) broadcastSse('cart_updated', { items: result.cartItems }, req.session.sub);
    if (checkoutReference) {
      broadcastSse('checkout_payment_completed', {
        checkoutReference,
        orderId: savedOrder.orderId,
        amount: savedOrder.total,
      }, req.session.sub);
    }
    return res.status(result.duplicate ? 200 : 201).json({
      ...result,
      order: {
        ...savedOrder,
        discountCodes: result.discountCodes || await discountCodesForOrder(savedOrder.orderId),
      },
    });
  } catch (error) {
    if (error.doNotRefund) return res.status(error.status || 409).json({ message: error.message });
    if (error.code === 11000) {
      const paymentOrder = await Order.findOne({ razorpayId: paymentId }).select('userId checkoutReference orderId').lean();
      if (paymentOrder) {
        if (paymentOrder.userId === req.session.sub && paymentOrder.checkoutReference === checkoutReference) {
          const existing = await Order.findOne({ orderId: paymentOrder.orderId }).lean();
          return res.json({ order: { ...existing, discountCodes: await discountCodesForOrder(existing.orderId) }, duplicate: true, notification: null });
        }
        return res.status(409).json({ message: 'This payment has already been linked to another order.' });
      }
    }
    if (paymentVerified) {
      try {
        const refund = await refundRazorpayPayment(paymentId, paymentAmountPaise);
        if (checkoutReference) await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: 'Completing' },
          { $set: { status: 'Interrupted', paymentStatus: 'Failed', reason: 'The captured payment was refunded because the order could not be completed.' } },
        );
        const refundMessage = refund.alreadyRefunded || refund.refundId
          ? 'The payment was refunded because the order could not be completed.'
          : 'The order could not be completed and the captured payment was refunded.';
        return res.status(409).json({ message: refundMessage, refundId: refund.refundId || null });
      } catch (refundError) {
        if (checkoutReference) await CheckoutAttempt.updateOne(
          { reference: checkoutReference, userId: req.session.sub, status: 'Completing' },
          { $set: { status: 'Payment Review', paymentStatus: 'Paid', reason: `Order failed and automatic refund failed: ${refundError.message}` } },
        );
        return res.status(409).json({ message: `${error.message} No order was created. Automatic refund failed: ${refundError.message}` });
      }
    }
    if (error.status) return res.status(error.status).json({ message: error.message });
    throw error;
  }
});

app.get('/api/custom-orders', requireSession, requireDatabase, async (req, res) => {
  const [customOrders, notifications] = await Promise.all([
    CustomOrder.find({ userId: req.session.sub }).sort({ createdAt: -1 }).lean(),
    Notification.find({ userId: req.session.sub }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  return res.json({ customOrders, notifications });
});

app.post('/api/custom-orders', requireSession, requireDatabase, async (req, res) => {
  const requestedItem = typeof req.body?.requestedItem === 'string' ? req.body.requestedItem.trim() : '';
  if (!requestedItem || requestedItem.length > 120) {
    return res.status(400).json({ message: 'Enter an item name up to 120 characters long.' });
  }

  const normalizedItem = requestedItem.toLocaleLowerCase();
  const activeRequest = await CustomOrder.findOne({
    userId: req.session.sub,
    normalizedItem,
    status: { $in: ['Pending', 'Accepted'] },
  }).lean();
  if (activeRequest) return res.json({ customOrder: activeRequest, duplicate: true });

  try {
    const customOrder = await CustomOrder.create({
      userId: req.session.sub,
      userName: req.session.name || req.session.email.split('@')[0],
      userEmail: req.session.email,
      requestedItem,
      normalizedItem,
      status: 'Pending',
    });
    return res.status(201).json({ customOrder, duplicate: false });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await CustomOrder.findOne({ userId: req.session.sub, normalizedItem, status: 'Pending' }).lean();
      if (duplicate) return res.json({ customOrder: duplicate, duplicate: true });
    }
    throw error;
  }
});

app.get('/api/admin/custom-orders', requireSession, requireAdmin, requireDatabase, async (_req, res) => {
  const customOrders = await CustomOrder.find().sort({ createdAt: -1 }).lean();
  return res.json({ customOrders });
});

app.patch('/api/admin/custom-orders/:id', requireSession, requireAdmin, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Custom order was not found.' });
  }

  const { status, price } = req.body || {};
  if (!['Accepted', 'Rejected'].includes(status)) {
    return res.status(400).json({ message: 'Choose Accept or Reject for this request.' });
  }
  if (status === 'Accepted' && (!Number.isFinite(Number(price)) || Number(price) < 1)) {
    return res.status(400).json({ message: 'Enter a valid price before accepting this request.' });
  }

  const updates = status === 'Accepted'
    ? { status, price: Number(price), acceptedAt: new Date() }
    : { status };
  const customOrder = await CustomOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'Pending' },
    { $set: updates },
    { new: true, runValidators: true },
  ).lean();
  if (!customOrder) return res.status(409).json({ message: 'This request is no longer pending.' });

  if (status === 'Accepted') {
    await Notification.create({
      userId: customOrder.userId,
      customOrderId: customOrder._id,
      message: `${customOrder.requestedItem} was accepted and is available to order for ₹${customOrder.price}.`,
    });
  } else {
    await Notification.create({
      userId: customOrder.userId,
      customOrderId: customOrder._id,
      message: `${customOrder.requestedItem} was not accepted.`,
    });
  }
  return res.json({ customOrder });
});

app.post('/api/custom-orders/:id/ordered', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: 'Custom order was not found.' });
  }
  const customOrder = await CustomOrder.findOneAndUpdate(
    { _id: req.params.id, userId: req.session.sub, status: 'Accepted' },
    { $set: { status: 'Ordered', orderedAt: new Date() } },
    { new: true },
  ).lean();
  if (!customOrder) return res.status(409).json({ message: 'This accepted custom order is no longer available.' });
  return res.json({ customOrder });
});

const InquiryBooking = mongoose.model('InquiryBooking', new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  bookingReference: { type: String, required: true, unique: true, index: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true, lowercase: true },
  phoneNumber: { type: String, required: true, index: true },
  category: { type: String, enum: ['Inquiry', 'General Inquiry', 'Problem'], required: true },
  dateKey: { type: String, required: true },
  slotStart: { type: Date, required: true },
  slotEnd: { type: Date, required: true },
  subscriptionPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  priorityBooking: { type: Boolean, default: false },
  token: { type: String, default: undefined },
  tokenStatus: { type: String, enum: ['awaiting_token', 'token_generated', 'active', 'completed'], default: 'awaiting_token', index: true },
  tokenPasswordHash: { type: String, select: false },
  tokenPasswordEncrypted: { type: String, select: false },
  reservationKey: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['Upcoming', 'Ready', 'In Progress', 'Completed', 'Cancelled', 'Expired'], default: 'Upcoming', index: true },
  sessionStartedAt: Date,
  sessionEndsAt: Date,
  stoppedBy: String,
}, { timestamps: true, autoIndex: false }));
InquiryBooking.schema.index(
  { dateKey: 1, token: 1 },
  { unique: true, partialFilterExpression: { token: { $type: 'string' } }, name: 'inquiry_daily_token_unique' },
);
InquiryBooking.schema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { tokenStatus: 'active' }, name: 'inquiry_one_active_token_per_customer' },
);
InquiryBooking.schema.index({ userId: 1, phoneNumber: 1, slotStart: -1 });
InquiryBooking.schema.index({ status: 1, slotStart: 1 });
let inquiryTokenIndexesReady = false;
const ensureInquiryTokenIndexes = async () => {
  const collections = await mongoose.connection.db.listCollections({
    name: InquiryBooking.collection.collectionName,
  }).toArray();
  if (!collections.length) {
    try {
      await InquiryBooking.createCollection();
    } catch (error) {
      if (error.code !== 48) throw error;
    }
  }
  await InquiryBooking.collection.updateMany(
    { bookingReference: { $exists: false } },
    [{ $set: { bookingReference: { $concat: ['INQ-', { $toUpper: { $substrBytes: [{ $toString: '$_id' }, 0, 20] } }] } } }],
  );
  await InquiryBooking.collection.updateMany(
    { tokenStatus: { $exists: false } },
    [{ $set: { tokenStatus: { $cond: [{ $eq: [{ $type: '$token' }, 'string'] }, 'token_generated', 'awaiting_token'] } } }],
  );
  const tokenBookingsNeedingPasswords = await InquiryBooking.find({
    token: { $type: 'string' },
    tokenPasswordHash: { $exists: false },
  }).select('_id').lean();
  for (const booking of tokenBookingsNeedingPasswords) {
    const credentials = createInquiryTokenCredentials();
    await InquiryBooking.updateOne(
      { _id: booking._id, token: { $type: 'string' }, tokenPasswordHash: { $exists: false } },
      { $set: { tokenPasswordHash: credentials.tokenPasswordHash, tokenPasswordEncrypted: credentials.tokenPasswordEncrypted } },
    );
  }
  const bookingsWithTokens = await InquiryBooking.find({ token: { $type: 'string' } })
    .select('+tokenPasswordHash +tokenPasswordEncrypted').lean();
  for (const booking of bookingsWithTokens) {
    await InquiryToken.updateOne(
      { bookingId: booking._id },
      {
        $setOnInsert: {
          bookingId: booking._id,
          bookingReference: booking.bookingReference,
          userId: booking.userId,
          customerName: booking.customerName,
          customerEmail: booking.customerEmail,
          phoneNumber: booking.phoneNumber,
          dateKey: booking.dateKey,
          slotStart: booking.slotStart,
          slotEnd: booking.slotEnd,
          subscriptionPlan: booking.subscriptionPlan || 'Starter',
          priorityBooking: Boolean(booking.priorityBooking),
          category: booking.category,
          token: booking.token,
          tokenStatus: booking.tokenStatus === 'active' ? 'active' : booking.tokenStatus === 'completed' ? 'completed' : 'token_generated',
          tokenPasswordHash: booking.tokenPasswordHash,
          tokenPasswordEncrypted: booking.tokenPasswordEncrypted,
          sessionStartedAt: booking.sessionStartedAt || undefined,
          sessionEndsAt: booking.sessionEndsAt || undefined,
        },
      },
      { upsert: true },
    );
  }
  await InquiryToken.init();
  await InquiryToken.createIndexes();
  await InquiryBooking.updateMany(
    { tokenStatus: 'active', status: { $in: ['Completed', 'Cancelled', 'Expired'] } },
    { $set: { tokenStatus: 'completed' } },
  );
  await InquiryBooking.updateMany(
    { tokenStatus: 'active', status: { $in: ['Upcoming', 'Ready'] } },
    { $set: { tokenStatus: 'token_generated' } },
  );
  await InquiryToken.updateMany(
    { tokenStatus: 'active', bookingId: { $in: await InquiryBooking.find({ status: { $in: ['Upcoming', 'Ready'] }, tokenStatus: 'token_generated' }).distinct('_id') } },
    { $set: { tokenStatus: 'token_generated' }, $unset: { sessionStartedAt: 1, sessionEndsAt: 1 } },
  );
  const indexes = await InquiryBooking.collection.indexes();
  for (const index of indexes) {
    const keys = index.key || {};
    if (index.name !== 'inquiry_daily_token_unique' && keys.dateKey === 1 && keys.token === 1) {
      try {
        await InquiryBooking.collection.dropIndex(index.name);
      } catch (error) {
        if (error.code !== 27) throw error;
      }
    }
  }
  await InquiryBooking.createIndexes();
  inquiryTokenIndexesReady = true;
};
const requireInquiryTokenIndexes = (_req, res, next) => {
  if (!inquiryTokenIndexesReady) return res.status(503).json({ message: 'Booking services are starting up. Please try again shortly.' });
  return next();
};

const InquiryDailyToken = mongoose.model('InquiryDailyToken', new mongoose.Schema({
  _id: { type: String },
  sequence: { type: Number, default: 0 },
}));
const InquiryToken = mongoose.model('InquiryToken', new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'InquiryBooking', required: true, unique: true, index: true },
  bookingReference: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true, lowercase: true },
  phoneNumber: { type: String, required: true, index: true },
  dateKey: { type: String, required: true, index: true },
  slotStart: { type: Date, required: true },
  slotEnd: { type: Date, required: true },
  category: { type: String, enum: ['Inquiry', 'General Inquiry', 'Problem'], required: true },
  token: { type: String, required: true },
  tokenStatus: { type: String, enum: ['token_generated', 'active', 'completed', 'cancelled'], default: 'token_generated', index: true },
  tokenPasswordHash: { type: String, required: true, select: false },
  tokenPasswordEncrypted: { type: String, required: true, select: false },
  sessionStartedAt: Date,
  sessionEndsAt: Date,
}, { timestamps: true }));
InquiryToken.schema.index({ dateKey: 1, token: 1 }, { unique: true });
InquiryToken.schema.index({ userId: 1, phoneNumber: 1, createdAt: -1 });
const inquiryTokenPasswordHash = (password, salt = crypto.randomBytes(16)) => ({
  salt: salt.toString('base64url'),
  hash: crypto.scryptSync(password, salt, 64).toString('base64url'),
});
const inquiryTokenPasswordMatches = (password, storedHash) => {
  if (typeof storedHash !== 'string') return false;
  const [saltValue, hashValue] = storedHash.split('.');
  if (!saltValue || !hashValue) return false;
  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
const createInquiryTokenPassword = () => {
  const chars = [];
  for (let index = 0; index < 4; index += 1) chars.push(String.fromCharCode(65 + crypto.randomInt(26)));
  for (let index = 0; index < 4; index += 1) chars.push(String(crypto.randomInt(10)));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join('');
};
const inquiryTokenPasswordEncryptionKey = () => {
  if (!sessionSecret) throw new Error('SESSION_SECRET must be configured to secure inquiry token passwords.');
  return crypto.scryptSync(sessionSecret, 'innovation-labs-inquiry-token-password-v1', 32);
};
const encryptInquiryTokenPassword = (password) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', inquiryTokenPasswordEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
};
const decryptInquiryTokenPassword = (encrypted) => {
  if (typeof encrypted !== 'string') return null;
  const [ivValue, tagValue, ciphertextValue] = encrypted.split('.');
  if (!ivValue || !tagValue || !ciphertextValue) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', inquiryTokenPasswordEncryptionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};
const createInquiryTokenCredentials = () => {
  const password = createInquiryTokenPassword();
  const { salt, hash } = inquiryTokenPasswordHash(password);
  return {
    password,
    tokenPasswordHash: `${salt}.${hash}`,
    tokenPasswordEncrypted: encryptInquiryTokenPassword(password),
  };
};
const InquiryMessage = mongoose.model('InquiryMessage', new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'InquiryBooking', required: true, index: true },
  authorId: { type: String, required: true },
  authorRole: { type: String, enum: ['customer', 'admin'], required: true },
  text: { type: String, default: '', maxlength: 4000 },
  kind: { type: String, enum: ['chat', 'scheduled'], default: 'chat' },
  paymentRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'InquiryPaymentRequest' },
  paymentSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  deliveryStatus: { type: String, enum: ['sent', 'scheduled', 'delivered', 'cancelled'], default: 'sent' },
  attachments: [{
    name: { type: String, required: true },
    fileName: { type: String },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, select: false },
  }],
  clientMessageId: { type: String, default: undefined },
}, { timestamps: true }));
InquiryMessage.schema.index(
  { bookingId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: 'scheduled' } },
);
InquiryMessage.schema.index({ bookingId: 1, createdAt: 1 });
InquiryMessage.schema.index(
  { bookingId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
const InquiryPaymentRequest = mongoose.model('InquiryPaymentRequest', new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'InquiryBooking', required: true, index: true },
  customerId: { type: String, required: true, index: true },
  adminId: { type: String, required: true },
  baseAmountPaise: { type: Number, min: 1 },
  amountPaise: { type: Number, required: true, min: 1 },
  subscriptionDiscountAmountPaise: { type: Number, min: 0, default: 0 },
  subscriptionDiscountPlan: { type: String, enum: Object.keys(planConfig), default: 'Starter' },
  subscriptionDiscountPercent: { type: Number, min: 0, max: 100, default: 0 },
  description: { type: String, required: true, trim: true, maxlength: 300 },
  status: { type: String, enum: ['Pending', 'Paid', 'Cancelled'], default: 'Pending', index: true },
  paymentMethod: { type: String, enum: ['Wallet', 'Razorpay'] },
  paymentReference: String,
  paidAt: Date,
  cancelledAt: Date,
  idempotencyKey: { type: String, default: undefined },
}, { timestamps: true }));
InquiryPaymentRequest.schema.index({ customerId: 1, status: 1, createdAt: -1 });
InquiryPaymentRequest.schema.index(
  { bookingId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
const InquiryPaymentAttempt = mongoose.model('InquiryPaymentAttempt', new mongoose.Schema({
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'InquiryPaymentRequest', required: true, index: true },
  customerId: { type: String, required: true, index: true },
  method: { type: String, enum: ['Wallet', 'Razorpay'], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['Pending', 'Successful', 'Failed', 'Cancelled'], default: 'Pending', index: true },
  razorpayOrderId: { type: String, unique: true, sparse: true },
  paymentId: { type: String, unique: true, sparse: true },
  failureMessage: String,
}, { timestamps: true }));
const CheckoutAttempt = mongoose.model('CheckoutAttempt', new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true, lowercase: true },
  customerPhone: { type: String, default: '' },
  items: { type: [mongoose.Schema.Types.Mixed], required: true },
  address: { type: mongoose.Schema.Types.Mixed },
  service: { type: String, required: true },
  totalPaise: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  stage: { type: String, enum: ['Checkout Opened', 'Payment Initiated'], default: 'Checkout Opened' },
  status: { type: String, enum: ['Open', 'Completing', 'Explicitly Cancelled', 'Interrupted', 'Expired', 'Payment Review', 'Completed'], default: 'Open', index: true },
  reason: { type: String, default: '' },
  paymentStatus: { type: String, enum: ['Not Started', 'Pending', 'Paid', 'Failed'], default: 'Not Started' },
  paymentReference: String,
  expiresAt: Date,
  razorpayOrderId: String,
  exitedAt: Date,
  completedAt: Date,
}, { timestamps: true }));
CheckoutAttempt.schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
CheckoutAttempt.schema.index({ status: 1, createdAt: -1 });
const checkoutItemsSnapshot = (items) => items.map((item) => ({
  id: String(item.id || item.productId || item.customOrderId || ''),
  name: String(item.name || 'Item'),
  category: String(item.category || 'Product'),
  quantity: Number(item.quantity),
  unitPricePaise: toPaise(item.price),
  ...(item.discountOfferId ? { discountOfferId: String(item.discountOfferId) } : {}),
  ...(item.customOrderId ? { customOrderId: String(item.customOrderId) } : {}),
  ...(item.promoReservationId ? { promoReservationId: String(item.promoReservationId) } : {}),
}));
const checkoutAttemptMatches = (attempt, { items, service, totalPaise }) => (
  attempt.service === service
  && attempt.totalPaise === totalPaise
  && JSON.stringify(attempt.items) === JSON.stringify(checkoutItemsSnapshot(items))
);
const checkoutAttemptProductChanged = (attempt, items) => {
  const previous = new Map((attempt.items || []).map((item) => [item.id, item]));
  return checkoutItemsSnapshot(items).some((item) => {
    const saved = previous.get(item.id);
    return saved && !item.id.startsWith('custom-') && !item.id.startsWith('discount-offer-')
      && (saved.name !== item.name || saved.category !== item.category || saved.unitPricePaise !== item.unitPricePaise);
  });
};
const InquiryBusinessSettings = mongoose.model('InquiryBusinessSettings', new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  timezone: { type: String, required: true },
  openTime: { type: String, required: true },
  closeTime: { type: String, required: true },
  workingDays: { type: [Number], required: true },
  updatedBy: String,
}, { timestamps: true }));

const legacyInquiryUploadDirectory = path.resolve(
  process.env.LEGACY_INQUIRY_UPLOAD_DIR
    || process.env.INQUIRY_UPLOAD_DIR
    || path.join(path.dirname(fileURLToPath(import.meta.url)), 'uploads', 'inquiries'),
);
const inquiryTimezone = process.env.INQUIRY_TIMEZONE || 'Asia/Kolkata';
const parsedInquiryWorkingDays = String(process.env.INQUIRY_WORKING_DAYS || '1,2,3,4,5,6')
  .split(',').map((day) => Number(day.trim()));
const inquiryDefaultWorkingDays = parsedInquiryWorkingDays.length
  && parsedInquiryWorkingDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ? [...new Set(parsedInquiryWorkingDays)] : [1, 2, 3, 4, 5, 6];
const inquiryAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Problem attachments must be JPEG, PNG, or WebP images.'));
    }
    return callback(null, true);
  },
});
const handleInquiryAttachmentUpload = (req, res, next) => {
  inquiryAttachmentUpload.array('attachments', 3)(req, res, (error) => {
    if (!error) return next();
    const status = error instanceof multer.MulterError ? 413 : 400;
    return res.status(status).json({ message: error.message || 'The attachment could not be uploaded.' });
  });
};
const inquiryPhoneAttempts = new Map();
const inquiryTokenVerificationAttempts = new Map();
const inquiryPhone = (value) => {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!/^[+()\d\s-]{7,20}$/.test(raw) || digits.length < 10 || digits.length > 15) return null;
  return digits;
};
const inquiryDateKey = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const inquiryDateParts = (dateKey) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, date };
};
const inquiryAddMonths = (dateKey, count) => {
  const parts = inquiryDateParts(dateKey);
  const monthDate = new Date(Date.UTC(parts.year, parts.month - 1 + count, 1));
  const lastDay = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
  return `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(parts.day, lastDay)).padStart(2, '0')}`;
};
const inquiryAddDays = addInquiryDays;
const inquiryLocalDateTime = (dateKey, minutes, timezone) => {
  const parts = inquiryDateParts(dateKey);
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(minutes / 60), minutes % 60);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const get = (type) => Number(formatted.find((part) => part.type === type)?.value);
    const observed = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const delta = target - observed;
    guess += delta;
    if (!delta) break;
  }
  return new Date(guess);
};
const inquiryMinutes = (value) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};
const getInquirySettings = async () => {
  let settings = await InquiryBusinessSettings.findOne({ key: 'default' }).lean();
  if (!settings) {
    settings = await InquiryBusinessSettings.findOneAndUpdate(
      { key: 'default' },
      { $setOnInsert: {
        timezone: inquiryTimezone,
        openTime: process.env.INQUIRY_OPEN_TIME || '10:30',
        closeTime: process.env.INQUIRY_CLOSE_TIME || '17:00',
        workingDays: inquiryDefaultWorkingDays,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  }
  return settings;
};
const inquirySlots = (dateKey, settings, now = new Date()) => {
  const dateParts = inquiryDateParts(dateKey);
  const open = inquiryMinutes(settings.openTime);
  const close = inquiryMinutes(settings.closeTime);
  if (!dateParts || open === null || close === null || close <= open
    || !settings.workingDays.includes(dateParts.date.getUTCDay())) return [];
  const slots = [];
  for (let start = open; start + 30 <= close; start += 30) {
    const slotStart = inquiryLocalDateTime(dateKey, start, settings.timezone);
    const slotEnd = inquiryLocalDateTime(dateKey, start + 30, settings.timezone);
    if (slotStart > now) slots.push({ start: slotStart, end: slotEnd });
  }
  return slots;
};
const inquiryBookingView = (booking) => ({
  id: String(booking._id),
  bookingReference: booking.bookingReference,
  customerName: booking.customerName,
  customerEmail: booking.customerEmail,
  phoneNumber: booking.phoneNumber,
  category: booking.category,
  dateKey: booking.dateKey,
  slotStart: booking.slotStart,
  slotEnd: booking.slotEnd,
  token: booking.token ? inquiryTokenDisplay(booking.token) : null,
  tokenStatus: booking.tokenStatus || (booking.token ? 'token_generated' : 'awaiting_token'),
  status: booking.status,
  sessionStartedAt: booking.sessionStartedAt || null,
  sessionEndsAt: booking.sessionEndsAt || null,
  scheduledMessageStatus: null,
  createdAt: booking.createdAt,
});
const inquiryTokenDisplay = (token) => {
  const digits = String(token || '').replace(/^#/, '');
  if (!/^\d+$/.test(digits)) return token;
  return String(Number(digits)).padStart(2, '0');
};
const inquiryTokenAvailableAt = (slotStart, timezone) => new Intl.DateTimeFormat('en-IN', {
  timeZone: timezone,
  dateStyle: 'long',
  timeStyle: 'short',
}).format(new Date(slotStart));
const inquiryBookingDetails = async (booking) => {
  const view = inquiryBookingView(booking);
  const scheduled = await InquiryMessage.findOne({ bookingId: booking._id, kind: 'scheduled' }).select('deliveryStatus').lean();
  view.scheduledMessageStatus = scheduled?.deliveryStatus || 'Not scheduled';
  return view;
};
const inquiryStartEligibility = async (booking, now = new Date()) => {
  if (!['Upcoming', 'Ready'].includes(booking.status)) {
    return { eligible: false, message: 'This booking is no longer eligible to start a chat.' };
  }
  if (!booking.token || booking.tokenStatus !== 'token_generated') {
    return { eligible: false, message: 'Cannot Start Chat Yet. A valid token must be generated for this booking before the inquiry chat can start.' };
  }
  if (booking.slotStart > now) {
    const settings = await getInquirySettings();
    return { eligible: false, message: `Cannot Start Chat Yet. The chat can start only during the eligible booking time, beginning at ${inquiryTokenAvailableAt(booking.slotStart, settings.timezone)} (${settings.timezone}).` };
  }
  if (booking.slotEnd <= now) {
    return { eligible: false, message: 'This booking time has ended. The inquiry chat cannot be started.' };
  }
  if (await InquiryBooking.exists({ userId: booking.userId, tokenStatus: 'active', _id: { $ne: booking._id } })) {
    return { eligible: false, message: 'This customer already has an active inquiry session.' };
  }
  const tokenRecord = await InquiryToken.exists({
    bookingId: booking._id,
    userId: booking.userId,
    token: booking.token,
    tokenStatus: 'token_generated',
    dateKey: booking.dateKey,
    slotStart: booking.slotStart,
    slotEnd: booking.slotEnd,
    category: booking.category,
  });
  if (!tokenRecord) {
    return { eligible: false, message: 'Cannot Start Chat Yet. A valid token must be generated for this booking before the inquiry chat can start.' };
  }
  return { eligible: true, message: null };
};
const inquiryTokenEligibility = async (_userId, bookings) => {
  return bookings.map((booking) => {
    const hasToken = typeof booking.token === 'string' && booking.token.length > 0;
    let blockedReason = '';
    if (!hasToken && !['Upcoming', 'Ready', 'In Progress'].includes(booking.status)) {
      blockedReason = `This booking is ${String(booking.status || 'unavailable').toLowerCase()}.`;
    }
    return {
      ...inquiryBookingView(booking),
      tokenPassword: hasToken ? decryptInquiryTokenPassword(booking.tokenPasswordEncrypted) : null,
      canGenerateToken: hasToken || !blockedReason,
      tokenBlockedReason: blockedReason || null,
    };
  });
};
const inquiryMessageView = (message) => ({
  id: String(message._id),
  authorId: message.authorId,
  authorRole: message.authorRole,
  text: message.text,
  kind: message.kind,
  deliveryStatus: message.deliveryStatus,
  paymentRequestId: message.paymentRequestId ? String(message.paymentRequestId) : null,
  paymentRequest: message.paymentSnapshot || null,
  createdAt: message.createdAt,
  attachments: (message.attachments || []).map((attachment) => ({
    id: String(attachment._id),
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: `/api/inquiries/attachments/${attachment._id}`,
  })),
});
const migrateLegacyInquiryAttachments = async () => {
  let migratedCount = 0;
  let unavailableCount = 0;
  const cursor = InquiryMessage.find({
    attachments: { $elemMatch: { data: { $exists: false }, fileName: { $type: 'string' } } },
  }).select('+attachments.data').cursor({ batchSize: 1 });

  for await (const message of cursor) {
    let updated = false;
    let migratedForMessage = 0;
    for (const attachment of message.attachments) {
      if (attachment.data?.length || !attachment.fileName) continue;
      try {
        attachment.data = await fs.readFile(path.join(legacyInquiryUploadDirectory, path.basename(attachment.fileName)));
        updated = true;
        migratedForMessage += 1;
      } catch (error) {
        if (error.code === 'ENOENT') {
          unavailableCount += 1;
          continue;
        }
        throw error;
      }
    }
    if (updated) {
      await message.save();
      migratedCount += migratedForMessage;
    }
  }

  if (migratedCount) console.log(`Migrated ${migratedCount} legacy inquiry attachment(s) into MongoDB.`);
  if (unavailableCount) console.warn(`${unavailableCount} legacy inquiry attachment(s) could not be migrated because their local files were missing.`);
};
const inquiryPaymentSnapshot = (paymentRequest) => ({
  id: String(paymentRequest._id),
  baseAmountPaise: paymentRequest.baseAmountPaise ?? paymentRequest.amountPaise,
  amountPaise: paymentRequest.amountPaise,
  subscriptionDiscountAmountPaise: paymentRequest.subscriptionDiscountAmountPaise || 0,
  subscriptionDiscountPlan: paymentRequest.subscriptionDiscountPlan || 'Starter',
  subscriptionDiscountPercent: paymentRequest.subscriptionDiscountPercent || 0,
  description: paymentRequest.description,
  status: paymentRequest.status,
  paymentMethod: paymentRequest.paymentMethod || null,
  paymentReference: paymentRequest.paymentReference || null,
  paidAt: paymentRequest.paidAt || null,
});
const syncInquiryPaymentMessage = async (paymentRequest, session) => InquiryMessage.updateOne(
  { paymentRequestId: paymentRequest._id },
  { $set: { paymentSnapshot: inquiryPaymentSnapshot(paymentRequest) } },
  session ? { session } : undefined,
);
const inquiryFindParticipantBooking = async (req, id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const booking = await InquiryBooking.findById(id);
  if (!booking) return null;
  const isOwner = booking.userId === req.session.sub;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  return isOwner || isAdmin ? booking : null;
};
const inquiryFileSignatureValid = (file) => {
  const bytes = file.buffer;
  if (file.mimetype === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
};

app.post('/api/checkout-attempts', requireSession, requireDatabase, async (req, res) => {
  const { items, service = 'parts', discountCode = '', idempotencyKey } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50
    || !['parts', 'coding', 'building', 'full'].includes(service)
    || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: 'A valid cart, checkout service, and checkout reference are required.' });
  }
  try {
    const { safeItems } = await resolveOrderItems(items, req.session.sub);
    const calculated = calculateOrder(safeItems, service);
    const discount = discountCode
      ? await discountCodeContext({ session: null, userId: req.session.sub, code: discountCode, items: safeItems })
      : null;
    const discountAmountPaise = discount?.discountAmountPaise || 0;
    const subscriptionDiscount = await subscriptionDiscountForAmount(
      req.session.sub,
      Math.max(0, calculated.totalPaise - discountAmountPaise),
    );
    const totalPaise = Math.max(0, calculated.totalPaise - discountAmountPaise - subscriptionDiscount.amountPaise);
    const snapshot = checkoutItemsSnapshot(safeItems);
    const requestHash = crypto.createHash('sha256')
      .update(JSON.stringify({ items: snapshot, service, totalPaise, discountCode: discount?.code || '' }))
      .digest('hex');
    let attempt = await CheckoutAttempt.findOne({
      userId: req.session.sub, idempotencyKey, status: { $in: ['Open'] },
    });
    if (attempt && attempt.requestHash !== requestHash) {
      const activeWalletIdRequest = await WalletPaymentRequest.exists({
        checkoutReference: attempt.reference,
        requesterUserId: req.session.sub,
        status: { $in: ['Pending', 'Processing'] },
        expiresAt: { $gt: new Date() },
      });
      if (activeWalletIdRequest) {
        return res.status(409).json({ message: 'Cancel the active Wallet ID payment request before changing this checkout.' });
      }
      if (attempt.razorpayOrderId) {
        return res.status(409).json({ message: 'A product price or cart detail changed after payment was prepared. Return to your cart, review the latest total, and start checkout again.' });
      }
      attempt = await CheckoutAttempt.findOneAndUpdate(
        { _id: attempt._id, status: 'Open', razorpayOrderId: { $exists: false } },
        { $set: { requestHash, items: snapshot, service, totalPaise, stage: 'Checkout Opened', paymentStatus: 'Not Started' } },
        { returnDocument: 'after' },
      );
      if (!attempt) return res.status(409).json({ message: 'Checkout changed while product prices were being refreshed. Please start checkout again.' });
    }
    if (!attempt) {
      attempt = await CheckoutAttempt.findOne({
        userId: req.session.sub,
        requestHash,
        status: 'Open',
        updatedAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      }).sort({ updatedAt: -1 });
    }
    if (!attempt) {
      const user = await User.findOne({ googleId: req.session.sub }).select('name email phoneNumber address.phoneNumber').lean();
      if (!user) return res.status(401).json({ message: 'Sign in again before continuing checkout.' });
      attempt = await CheckoutAttempt.create({
        reference: crypto.randomUUID(),
        idempotencyKey,
        requestHash,
        userId: req.session.sub,
        customerName: user.name,
        customerEmail: user.email,
        customerPhone: user.phoneNumber || user.address?.phoneNumber || '',
        items: snapshot,
        service,
        totalPaise,
        stage: 'Checkout Opened',
      });
    }
    const requestedItemsById = new Map(items.map((item) => [String(item?.id || ''), item]));
    const priceChanges = safeItems.flatMap((item) => {
      const requested = requestedItemsById.get(String(item.id));
      const oldPrice = Number(requested?.price);
      return Number.isFinite(oldPrice) && oldPrice !== Number(item.price)
        ? [{ id: item.id, name: item.name, previousPrice: oldPrice, currentPrice: Number(item.price) }]
        : [];
    });
    return res.status(201).json({
      attempt: { reference: attempt.reference, status: attempt.status, stage: attempt.stage },
      items: safeItems,
      priceChanges,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('Checkout attempt could not be recorded:', error.message);
    return res.status(503).json({ message: 'Checkout could not be recorded. Please try again.' });
  }
});
app.get('/api/checkout-attempts/:reference', requireSession, requireDatabase, async (req, res) => {
  const attempt = await CheckoutAttempt.findOne({
    reference: req.params.reference,
    userId: req.session.sub,
  }).select('reference status paymentStatus paymentReference reason totalPaise completedAt updatedAt').lean();
  if (!attempt) return res.status(404).json({ message: 'Checkout payment record was not found.' });
  const order = attempt.paymentStatus === 'Paid'
    ? await Order.findOne({ checkoutReference: attempt.reference, userId: req.session.sub }).lean()
    : null;
  return res.json({
    attempt: {
      reference: attempt.reference,
      status: attempt.status,
      paymentStatus: attempt.paymentStatus,
      paymentReference: attempt.paymentReference,
      reason: attempt.reason,
      total: attempt.totalPaise / 100,
      completedAt: attempt.completedAt,
      updatedAt: attempt.updatedAt,
    },
    order: order ? buyerOrderView(order) : null,
  });
});
app.post('/api/checkout-attempts/:reference/stage', requireSession, requireDatabase, async (req, res) => {
  const currentAttempt = await CheckoutAttempt.findOne({
    reference: req.params.reference,
    userId: req.session.sub,
    status: 'Open',
  }).select('items expiresAt').lean();
  if (!currentAttempt) return res.status(409).json({ message: 'This checkout is no longer active.' });
  const address = req.body?.address;
  const hasAddress = address && typeof address === 'object' && !Array.isArray(address);
  const deliveryRequired = (currentAttempt.items || []).some((item) => !item.discountOfferId);
  if (deliveryRequired && (!hasAddress || !validateAddress(address))) {
    return res.status(400).json({ message: 'Complete the required delivery address fields before starting payment.' });
  }
  const stageUpdate = {
    $set: {
      address,
      stage: 'Payment Initiated',
      paymentStatus: 'Pending',
    },
  };
  if (!currentAttempt.expiresAt) stageUpdate.$set.expiresAt = new Date(Date.now() + 4 * 60 * 1000);
  const attempt = await CheckoutAttempt.findOneAndUpdate(
    { reference: req.params.reference, userId: req.session.sub, status: 'Open' },
    stageUpdate,
    { new: true },
  );
  if (!attempt) return res.status(409).json({ message: 'This checkout is no longer active.' });
  return res.json({ status: attempt.status, stage: attempt.stage, expiresAt: attempt.expiresAt });
});
app.post('/api/checkout-attempts/:reference/razorpay/order', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const attempt = await CheckoutAttempt.findOne({
    reference: req.params.reference,
    userId: req.session.sub,
    status: 'Open',
  });
  if (!attempt) return res.status(409).json({ message: 'This checkout is no longer active.' });
  const productIds = (attempt.items || []).map((item) => String(item.id || ''))
    .filter((id) => id && !id.startsWith('custom-') && !id.startsWith('discount-offer-'));
  if (productIds.length) {
    const products = await InventoryItem.find({ productId: { $in: productIds } })
      .select('productId name category pricePaise stock status').lean();
    const productById = new Map(products.map((product) => [product.productId, product]));
    const changedProduct = attempt.items.find((item) => {
      const id = String(item.id || '');
      if (!id || id.startsWith('custom-') || id.startsWith('discount-offer-')) return false;
      const product = productById.get(id);
      return !product || product.status === 'Out of Stock' || product.stock < Number(item.quantity)
        || Number(product.pricePaise) !== Number(item.unitPricePaise)
        || product.name !== item.name || product.category !== item.category;
    });
    if (changedProduct) {
      return res.status(409).json({ message: `The price or availability for ${changedProduct.name || 'a product'} changed after checkout began. Review the latest cart and total before paying.` });
    }
  }
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured on the server.' });
  if (attempt.razorpayOrderId) {
    return res.json({ orderId: attempt.razorpayOrderId, keyId: razorpayKeyId, amountPaise: attempt.totalPaise, currency: 'INR' });
  }
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: attempt.totalPaise,
        currency: 'INR',
        receipt: `il-${attempt.reference.slice(-28)}`,
      }),
    });
    const order = await response.json();
    if (!response.ok || !order.id || order.amount !== attempt.totalPaise || order.currency !== 'INR') {
      return res.status(502).json({ message: 'Razorpay could not create the checkout payment order.' });
    }
    const saved = await CheckoutAttempt.findOneAndUpdate(
      { _id: attempt._id, status: 'Open', razorpayOrderId: { $exists: false } },
      { $set: { razorpayOrderId: order.id, stage: 'Payment Initiated', paymentStatus: 'Pending' } },
      { new: true },
    );
    if (!saved) return res.status(409).json({ message: 'Checkout payment was initialized in another request. Retry safely.' });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise: order.amount, currency: order.currency });
  } catch (error) {
    console.error('Checkout Razorpay order creation failed:', error.message);
    return res.status(503).json({ message: 'Razorpay is temporarily unavailable.' });
  }
});
app.post('/api/checkout-attempts/:reference/exit', requireSession, requireDatabase, async (req, res) => {
  const { destination = '/' } = req.body || {};
  const now = new Date();
  const result = await withMongoTransaction(async (session) => {
    const attempt = await CheckoutAttempt.findOne({
      reference: req.params.reference,
      userId: req.session.sub,
    }).session(session);
    if (!attempt) throw Object.assign(new Error('This checkout could not be found.'), { status: 404 });
    const order = await Order.findOne({ checkoutReference: attempt.reference, userId: req.session.sub }).session(session).select('orderId').lean();
    if (order || attempt.status === 'Completed' || attempt.paymentStatus === 'Paid') {
      return { status: 'Completed', orderId: order?.orderId || null };
    }
    if (!['Open', 'Payment Initiated'].includes(attempt.status)) {
      await WalletPaymentRequest.updateMany(
        { checkoutReference: attempt.reference, requesterUserId: req.session.sub, status: { $in: ['Pending', 'Processing'] } },
        {
          $set: { status: 'Cancelled' },
          $unset: { activeCheckoutKey: 1 },
          $push: { statusHistory: { status: 'Payment Cancelled', at: now } },
        },
        { session },
      );
      return { status: attempt.status };
    }
    const updated = await CheckoutAttempt.findOneAndUpdate(
      { _id: attempt._id, status: { $in: ['Open', 'Payment Initiated'] }, paymentStatus: { $ne: 'Paid' } },
      { $set: {
        status: 'Explicitly Cancelled',
        reason: `Customer confirmed exit to ${String(destination).slice(0, 160)}.`,
        exitedAt: now,
      } },
      { new: true, session },
    );
    if (!updated) throw Object.assign(new Error('This checkout changed while it was being closed. Refresh before continuing.'), { status: 409 });
    await WalletPaymentRequest.updateMany(
      { checkoutReference: attempt.reference, requesterUserId: req.session.sub, status: { $in: ['Pending', 'Processing'] } },
      {
        $set: { status: 'Cancelled' },
        $unset: { activeCheckoutKey: 1 },
        $push: { statusHistory: { status: 'Payment Cancelled', at: now } },
      },
      { session },
    );
    return { status: updated.status };
  });
  const cancelledRequests = await WalletPaymentRequest.find({
    checkoutReference: req.params.reference,
    requesterUserId: req.session.sub,
    status: 'Cancelled',
  }).select('requestId checkoutReference requesterUserId payerUserId').lean();
  cancelledRequests.forEach((request) => broadcastWalletPaymentRequestUpdate(request, {
    requestId: request.requestId,
    checkoutReference: request.checkoutReference,
    status: 'Cancelled',
    serverTime: now.toISOString(),
  }));
  return res.json(result);
});
app.get('/api/admin/checkout-attempts', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
  const filter = { status: { $in: ['Explicitly Cancelled', 'Interrupted'] } };
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ customerName: new RegExp(escaped, 'i') }, { customerEmail: new RegExp(escaped, 'i') }, { customerPhone: new RegExp(escaped, 'i') }, { reference: new RegExp(escaped, 'i') }];
  }
  filter.status = { $in: ['Explicitly Cancelled', 'Interrupted', 'Payment Review'] };
  if (['Explicitly Cancelled', 'Interrupted', 'Payment Review'].includes(req.query.status)) filter.status = req.query.status;
  const fromValue = req.query.from ? String(req.query.from) : '';
  const toValue = req.query.to ? String(req.query.to) : '';
  const from = fromValue ? new Date(`${fromValue}T00:00:00.000Z`) : null;
  const to = toValue ? new Date(`${toValue}T00:00:00.000Z`) : null;
  if ((fromValue && (!/^\d{4}-\d{2}-\d{2}$/.test(fromValue) || !Number.isFinite(from?.getTime())))
    || (toValue && (!/^\d{4}-\d{2}-\d{2}$/.test(toValue) || !Number.isFinite(to?.getTime())))) {
    return res.status(400).json({ message: 'Enter valid checkout date filters.' });
  }
  if (from || to) filter.createdAt = {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lt: new Date(to.getTime() + 86400000) } : {}),
  };
  const [attempts, total] = await Promise.all([
    CheckoutAttempt.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CheckoutAttempt.countDocuments(filter),
  ]);
  return res.json({ attempts, page, limit, total });
});

app.get('/api/inquiries/availability', requireDatabase, async (req, res) => {
  try {
    const settings = await getInquirySettings();
    const now = new Date();
    const today = inquiryDateKey(now, settings.timezone);
    const finalDate = inquiryAddMonths(today, 2);
    const dateKeys = [];
    let key = today;
    while (key <= finalDate) {
      dateKeys.push(key);
      const current = inquiryDateParts(key);
      const next = new Date(current.date.getTime() + 86400000);
      key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
      if (dateKeys.length > 70) break;
    }
    const bookings = await InquiryBooking.find({ dateKey: { $in: dateKeys }, status: { $nin: ['Cancelled', 'Expired'] } }).select('dateKey slotStart').lean();
    const taken = new Set(bookings.map((booking) => `${booking.dateKey}:${new Date(booking.slotStart).toISOString()}`));
    let userId = '';
    try {
      userId = jwt.verify(req.cookies.innovation_session || '', sessionSecret)?.sub || '';
    } catch {
      userId = '';
    }
    const subscription = userId ? await currentSubscription(userId) : null;
    const exclusive = subscription?.plan === 'Exclusive';
    const availableSlots = (dateKey) => inquirySlots(dateKey, settings, now)
      .filter((slot) => !taken.has(`${dateKey}:${slot.start.toISOString()}`))
      .map((slot) => ({ start: slot.start, end: slot.end }));
    const slotsByDate = new Map(dateKeys.map((dateKey) => [dateKey, availableSlots(dateKey)]));
    const tomorrow = inquiryAddDays(today, 1);
    const dates = dateKeys.map((dateKey) => {
      const slots = slotsByDate.get(dateKey) || [];
      const priorityDate = dateKey === tomorrow;
      const available = isInquiryDateBookable(dateKey, today, subscription?.plan);
      return {
        dateKey,
        available,
        priorityBooking: exclusive && priorityDate,
        slots: available ? slots : [],
        unavailableReason: available ? null : 'Reserved for Exclusive subscribers until the booking window opens.',
      };
    });
    return res.json({
      timezone: settings.timezone,
      today,
      subscriptionPlan: subscription?.plan || 'Starter',
      priorityBooking: exclusive,
      dates,
    });
  } catch (error) {
    console.error('Inquiry availability failed:', error.message);
    return res.status(503).json({ message: 'Booking availability is temporarily unavailable.' });
  }
});

app.post('/api/inquiries/bookings', requireSession, requireDatabase, requireInquiryTokenIndexes, async (req, res) => {
  const { category, dateKey, slotStart } = req.body || {};
  const customerName = typeof req.body?.customerName === 'string' ? req.body.customerName.trim().replace(/\s+/g, ' ') : '';
  const customerEmail = typeof req.body?.customerEmail === 'string' ? req.body.customerEmail.trim().toLowerCase() : '';
  const phoneNumber = inquiryPhone(req.body?.phoneNumber);
  if (!['Inquiry', 'General Inquiry', 'Problem'].includes(category)
    || !customerName || customerName.length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.length > 254
    || !phoneNumber || !inquiryDateParts(dateKey) || !slotStart) {
    return res.status(400).json({ message: 'Enter a valid full name, email address, phone number, category, date, and available time slot.' });
  }
  const start = new Date(slotStart);
  if (!Number.isFinite(start.getTime())) return res.status(400).json({ message: 'The selected time is invalid.' });
  if (!await User.exists({ googleId: req.session.sub })) return res.status(401).json({ message: 'Sign in again before booking.' });
  const mongoSession = await mongoose.startSession();
  let created;
  try {
    await mongoSession.withTransaction(async () => {
      const settings = await getInquirySettings();
      const serverDateKey = inquiryDateKey(new Date(), settings.timezone);
      const lastDateKey = inquiryAddMonths(serverDateKey, 2);
      if (dateKey < serverDateKey || dateKey > lastDateKey) throw Object.assign(new Error('Choose a date within the current two-month booking window.'), { status: 400 });
      const subscription = await currentSubscription(req.session.sub, mongoSession);
      const exclusive = subscription?.plan === 'Exclusive';
      const tomorrow = inquiryAddDays(serverDateKey, 1);
      const priorityDateAllowed = exclusive && dateKey === tomorrow;
      if (!isInquiryDateBookable(dateKey, serverDateKey, subscription?.plan)) {
        throw Object.assign(new Error('Tomorrow is reserved for active Exclusive subscribers.'), { status: 403 });
      }
      const requestedSlot = inquirySlots(dateKey, settings).find((slot) => slot.start.getTime() === start.getTime());
      if (!requestedSlot) throw Object.assign(new Error('That time is not an available business slot.'), { status: 409 });
      const [booking] = await InquiryBooking.create([{
        userId: req.session.sub,
        bookingReference: `INQ-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
        customerName,
        customerEmail,
        phoneNumber,
        category,
        dateKey,
        slotStart: requestedSlot.start,
        slotEnd: requestedSlot.end,
        subscriptionPlan: subscription?.plan || 'Starter',
        priorityBooking: priorityDateAllowed,
        reservationKey: `${dateKey}:${requestedSlot.start.toISOString()}`,
        tokenStatus: 'awaiting_token',
      }], { session: mongoSession });
      created = booking.toObject();
    });
    return res.status(201).json({ booking: inquiryBookingView(created) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'That slot was just booked. Refresh availability and choose another time.' });
    console.error('Inquiry booking failed:', error.message);
    return res.status(503).json({ message: 'The booking could not be completed. Please try again.' });
  } finally {
    await mongoSession.endSession();
  }
});

app.post('/api/inquiries/bookings/lookup', requireSession, requireDatabase, async (req, res) => {
  const phoneNumber = inquiryPhone(req.body?.phoneNumber);
  if (!phoneNumber) return res.status(400).json({ message: 'Enter the phone number used for your booking.' });
  const key = String(req.session.sub);
  const attempt = inquiryPhoneAttempts.get(key) || { count: 0, since: Date.now() };
  if (Date.now() - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = Date.now(); }
  attempt.count += 1;
  inquiryPhoneAttempts.set(key, attempt);
  if (attempt.count > 10) return res.status(429).json({ message: 'Too many booking lookups. Please try again in a few minutes.' });
  await finalizeEndedInquirySessions(new Date());
  const bookings = await InquiryBooking.find({ userId: req.session.sub, phoneNumber })
    .select('+tokenPasswordEncrypted').sort({ slotStart: -1 }).lean();
  if (!bookings.length) return res.status(404).json({ message: 'No saved bookings found. Please check your phone number and try again.' });
  const tokenRecords = await InquiryToken.find({
    bookingId: { $in: bookings.map((booking) => booking._id) },
    userId: req.session.sub,
  }).select('+tokenPasswordEncrypted').lean();
  const tokenByBooking = new Map(tokenRecords.map((record) => [String(record.bookingId), record]));
  const recoveredBookings = bookings.map((booking) => {
    const tokenRecord = tokenByBooking.get(String(booking._id));
    return tokenRecord ? {
      ...booking,
      token: tokenRecord.token,
      tokenStatus: tokenRecord.tokenStatus,
      tokenPasswordEncrypted: tokenRecord.tokenPasswordEncrypted,
    } : booking;
  });
  const results = await inquiryTokenEligibility(req.session.sub, recoveredBookings);
  if (results.some((booking) => booking.token && !booking.tokenPassword)) {
    return res.status(503).json({ message: 'A saved token password cannot be recovered with the current server configuration. Contact support before proceeding.' });
  }
  return res.json({ bookings: results });
});

app.post('/api/inquiries/bookings/:id/generate-token', requireSession, requireDatabase, requireInquiryTokenIndexes, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Booking was not found.' });
  const existing = await InquiryBooking.findOne({ _id: req.params.id, userId: req.session.sub })
    .select('+tokenPasswordEncrypted');
  if (!existing) return res.status(404).json({ message: 'Booking was not found on your account.' });
  if (existing.token) {
    const tokenPassword = decryptInquiryTokenPassword(existing.tokenPasswordEncrypted);
    if (!tokenPassword) return res.status(503).json({ message: 'This token password cannot be recovered with the current server configuration. Contact support before proceeding.' });
    return res.json({ booking: { ...inquiryBookingView(existing), tokenPassword }, duplicate: true });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const current = await InquiryBooking.findOne({ _id: req.params.id, userId: req.session.sub })
        .select('+tokenPasswordEncrypted').session(session);
      if (!current) throw Object.assign(new Error('Booking was not found on your account.'), { status: 404 });
      if (current.token) return { booking: current, duplicate: true };
      if (!['Upcoming', 'Ready'].includes(current.status)) {
        throw Object.assign(new Error(`A token cannot be generated for a ${current.status.toLowerCase()} booking.`), { status: 409 });
      }
      const priorTokens = await InquiryBooking.find({ dateKey: current.dateKey, token: { $type: 'string' } })
        .select('token').session(session).lean();
      const highestIssued = priorTokens.reduce((highest, item) => {
        const number = Number(String(item.token).replace(/^#/, ''));
        return Number.isSafeInteger(number) ? Math.max(highest, number) : highest;
      }, 0);
      const sequence = await InquiryDailyToken.findOneAndUpdate(
        { _id: current.dateKey },
        [{
          $set: {
            sequence: {
              $add: [
                { $max: [{ $ifNull: ['$sequence', 0] }, highestIssued] },
                1,
              ],
            },
          },
        }],
        { upsert: true, new: true, session, updatePipeline: true },
      );
      const token = String(sequence.sequence).padStart(2, '0');
      const credentials = createInquiryTokenCredentials();
      await InquiryToken.create([{
        bookingId: current._id,
        bookingReference: current.bookingReference,
        userId: current.userId,
        customerName: current.customerName,
        customerEmail: current.customerEmail,
        phoneNumber: current.phoneNumber,
        dateKey: current.dateKey,
        slotStart: current.slotStart,
        slotEnd: current.slotEnd,
        category: current.category,
        token,
        tokenStatus: 'token_generated',
        tokenPasswordHash: credentials.tokenPasswordHash,
        tokenPasswordEncrypted: credentials.tokenPasswordEncrypted,
      }], { session });
      const updated = await InquiryBooking.findOneAndUpdate(
        {
          _id: current._id,
          userId: req.session.sub,
          status: { $in: ['Upcoming', 'Ready'] },
          $or: [{ token: { $exists: false } }, { token: null }],
        },
        { $set: {
          token,
          tokenStatus: 'token_generated',
          tokenPasswordHash: credentials.tokenPasswordHash,
          tokenPasswordEncrypted: credentials.tokenPasswordEncrypted,
        } },
        { new: true, session },
      );
      if (!updated) {
        const alreadyGenerated = await InquiryBooking.findOne({ _id: current._id, userId: req.session.sub })
          .select('+tokenPasswordEncrypted').session(session);
        if (alreadyGenerated?.token) return { booking: alreadyGenerated, duplicate: true };
        throw Object.assign(new Error('The token could not be generated. Please retry.'), { status: 409 });
      }
      return { booking: updated, duplicate: false, tokenPassword: credentials.password };
    });
    const tokenPassword = result.tokenPassword || decryptInquiryTokenPassword(result.booking.tokenPasswordEncrypted);
    if (!tokenPassword) return res.status(503).json({ message: 'The token was saved, but its password could not be recovered. Contact support before proceeding.' });
    return res.json({
      booking: { ...inquiryBookingView(result.booking), tokenPassword },
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000 && error.keyPattern?.userId) {
      return res.status(409).json({ message: 'You already have an active token for another booking.' });
    }
    console.error('Inquiry token generation failed:', error.message);
    return res.status(503).json({ message: 'The token could not be generated. Please retry.' });
  }
});

app.post('/api/inquiries/bookings/verify-token', requireSession, requireDatabase, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const passwordInput = String(req.body?.password || '').trim();
  if (!/^#?\d{1,6}$/.test(token)) return res.status(400).json({ message: 'Enter a valid booking token.' });
  if (!/^[A-Za-z0-9]{8}$/.test(passwordInput)
    || (passwordInput.match(/[A-Za-z]/g) || []).length !== 4
    || (passwordInput.match(/\d/g) || []).length !== 4) {
    return res.status(400).json({ message: 'Enter the eight-character token password containing four letters and four digits.' });
  }
  const attemptKey = String(req.session.sub);
  const attempt = inquiryTokenVerificationAttempts.get(attemptKey) || { count: 0, since: Date.now() };
  if (Date.now() - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = Date.now(); }
  attempt.count += 1;
  inquiryTokenVerificationAttempts.set(attemptKey, attempt);
  if (attempt.count > 10) return res.status(429).json({ message: 'Too many verification attempts. Please try again in a few minutes.' });
  const password = passwordInput.toUpperCase();
  const number = Number(token.replace(/^#/, ''));
  const formattedToken = String(number).padStart(2, '0');
  const tokenCandidates = [...new Set([
    formattedToken,
    String(number),
    `#0${formattedToken}`,
    `#${formattedToken}`,
    `#${number}`,
  ])];
  const tokenRecords = await InquiryToken.find({ userId: req.session.sub, token: { $in: tokenCandidates } })
    .select('+tokenPasswordHash').sort({ createdAt: -1 }).limit(100).lean();
  const matchedRecords = tokenRecords.filter((record) => inquiryTokenPasswordMatches(password, record.tokenPasswordHash));
  const bookings = await InquiryBooking.find({
    _id: { $in: matchedRecords.map((record) => record.bookingId) },
    userId: req.session.sub,
  }).sort({ slotStart: -1 }).lean();
  if (!bookings.length) return res.status(404).json({ message: 'The token number and password do not match a booking on your signed-in account.' });
  issueInquiryVerification(res, req.session, bookings);
  const settings = await getInquirySettings();
  return res.json({
    bookings: await Promise.all(bookings.map(inquiryBookingDetails)),
    timezone: settings.timezone,
    serverTime: new Date().toISOString(),
  });
});

app.get('/api/admin/inquiries/config', requireSession, requireDatabase, requireAdmin, async (_req, res) => {
  const settings = await getInquirySettings();
  return res.json({ settings });
});
app.put('/api/admin/inquiries/config', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const timezone = String(req.body?.timezone || '').trim();
  const openTime = String(req.body?.openTime || '');
  const closeTime = String(req.body?.closeTime || '');
  const workingDays = req.body?.workingDays;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return res.status(400).json({ message: 'Enter a valid IANA business timezone.' });
  }
  const open = inquiryMinutes(openTime);
  const close = inquiryMinutes(closeTime);
  if (open === null || close === null || close <= open || (close - open) % 30 !== 0
    || !Array.isArray(workingDays) || !workingDays.length
    || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return res.status(400).json({ message: 'Set valid business hours, 30-minute-aligned closing time, and at least one working day.' });
  }
  const settings = await InquiryBusinessSettings.findOneAndUpdate(
    { key: 'default' },
    { $set: { timezone, openTime, closeTime, workingDays: [...new Set(workingDays)], updatedBy: req.session.email } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return res.json({ settings });
});
app.get('/api/admin/inquiries/next', requireSession, requireDatabase, requireAdmin, async (_req, res) => {
  await processInquiryDueWork();
  const booking = await InquiryBooking.findOne({ status: { $in: ['Upcoming', 'Ready'] }, slotEnd: { $gt: new Date() } }).sort({ slotStart: 1 }).lean();
  return res.json({ booking: booking ? await inquiryBookingDetails(booking) : null });
});
app.get('/api/admin/inquiries', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
  const filter = {};
  if (['Inquiry', 'General Inquiry', 'Problem'].includes(req.query.category)) {
    filter.category = req.query.category === 'General Inquiry' ? { $in: ['Inquiry', 'General Inquiry'] } : req.query.category;
  }
  if (['Upcoming', 'Ready', 'In Progress', 'Completed', 'Cancelled', 'Expired'].includes(req.query.status)) filter.status = req.query.status;
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ customerName: regex }, { customerEmail: regex }, { phoneNumber: regex }, { token: regex }];
  }
  const [bookings, total] = await Promise.all([
    InquiryBooking.find(filter).sort({ slotStart: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    InquiryBooking.countDocuments(filter),
  ]);
  return res.json({ bookings: await Promise.all(bookings.map(inquiryBookingDetails)), page, limit, total });
});
app.get('/api/admin/inquiries/:id/start-eligibility', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Booking was not found.' });
  const booking = await InquiryBooking.findById(req.params.id).lean();
  if (!booking) return res.status(404).json({ message: 'Booking was not found.' });
  return res.json(await inquiryStartEligibility(booking));
});
app.post('/api/admin/inquiries/:id/start', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const now = new Date();
  await finalizeEndedInquirySessions(now);
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Booking was not found.' });
  const existing = await InquiryBooking.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ message: 'Booking was not found.' });
  const eligibility = await inquiryStartEligibility(existing, now);
  if (!eligibility.eligible) return res.status(409).json({ message: eligibility.message });
  let booking;
  try {
    booking = await withMongoTransaction(async (session) => {
      const activationTime = new Date();
      const current = await InquiryBooking.findOne({
        _id: req.params.id,
        status: { $in: ['Upcoming', 'Ready'] },
        token: existing.token,
        tokenStatus: 'token_generated',
        slotStart: { $lte: activationTime },
        slotEnd: { $gt: activationTime },
      }).session(session);
      if (!current) throw Object.assign(new Error('This booking is no longer eligible to start a chat.'), { status: 409 });
      if (current.slotStart > activationTime || current.slotEnd <= activationTime) {
        throw Object.assign(new Error('This booking is outside its eligible chat time.'), { status: 409 });
      }
      if (await InquiryBooking.exists({
        userId: current.userId,
        tokenStatus: 'active',
        _id: { $ne: current._id },
      }).session(session)) {
        throw Object.assign(new Error('This customer already has an active inquiry session.'), { status: 409 });
      }
      const tokenRecord = await InquiryToken.findOne({
        bookingId: current._id,
        userId: current.userId,
        token: current.token,
        tokenStatus: 'token_generated',
        dateKey: current.dateKey,
        slotStart: current.slotStart,
        slotEnd: current.slotEnd,
        category: current.category,
      }).session(session);
      if (!tokenRecord) {
        throw Object.assign(new Error('Cannot Start Chat Yet. A valid token must be generated for this booking before the inquiry chat can start.'), { status: 409 });
      }
      const activated = await InquiryBooking.findOneAndUpdate(
        {
          _id: current._id,
          userId: current.userId,
          status: { $in: ['Upcoming', 'Ready'] },
          token: current.token,
          tokenStatus: 'token_generated',
          slotStart: { $lte: activationTime },
          slotEnd: { $gt: activationTime },
        },
        { $set: {
          status: 'In Progress',
          tokenStatus: 'active',
          sessionStartedAt: activationTime,
          sessionEndsAt: current.slotEnd,
        } },
        { new: true, session },
      );
      if (!activated) throw Object.assign(new Error('This booking is no longer eligible to start a chat.'), { status: 409 });
      const tokenUpdate = await InquiryToken.updateOne(
        { _id: tokenRecord._id, tokenStatus: 'token_generated' },
        { $set: { tokenStatus: 'active', sessionStartedAt: activationTime, sessionEndsAt: current.slotEnd } },
        { session },
      );
      if (tokenUpdate.modifiedCount !== 1) throw Object.assign(new Error('The booking token is no longer valid for this session.'), { status: 409 });
      return activated;
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This customer already has an active inquiry session.' });
    console.error('Inquiry session activation failed:', error.message);
    return res.status(503).json({ message: 'The inquiry chat could not be activated. Please try again.' });
  }
  return res.json({ booking: await inquiryBookingDetails(booking) });
});
app.post('/api/admin/inquiries/:id/stop', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  let booking;
  await withMongoTransaction(async (session) => {
    booking = await InquiryBooking.findOneAndUpdate(
      { _id: req.params.id, status: 'In Progress' },
      [{ $set: { status: 'Completed', tokenStatus: { $cond: [{ $eq: ['$tokenStatus', 'active'] }, 'completed', '$tokenStatus'] }, sessionEndsAt: new Date(), stoppedBy: req.session.email } }],
      { new: true, session, updatePipeline: true },
    );
    if (!booking) return;
    await InquiryToken.updateOne(
      { bookingId: booking._id, tokenStatus: 'active' },
      { $set: { tokenStatus: 'completed', sessionEndsAt: new Date() } },
      { session },
    );
    await InquiryMessage.updateMany(
      { bookingId: booking._id, kind: 'scheduled', deliveryStatus: 'scheduled' },
      { $set: { deliveryStatus: 'cancelled' } },
      { session },
    );
  });
  if (!booking) return res.status(409).json({ message: 'This conversation is not active.' });
  return res.json({ booking: inquiryBookingView(booking) });
});
app.post('/api/admin/inquiries/:id/cancel', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  let booking;
  await withMongoTransaction(async (session) => {
    booking = await InquiryBooking.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ['Upcoming', 'Ready'] }, slotStart: { $gt: new Date() } },
      [{ $set: { status: 'Cancelled', tokenStatus: { $cond: [{ $eq: [{ $type: '$token' }, 'string'] }, 'completed', '$tokenStatus'] }, stoppedBy: req.session.email } }, { $unset: 'reservationKey' }],
      { new: true, session, updatePipeline: true },
    );
    if (!booking) return;
    await InquiryToken.updateOne(
      { bookingId: booking._id, tokenStatus: { $in: ['active', 'token_generated'] } },
      { $set: { tokenStatus: 'cancelled' } },
      { session },
    );
    await InquiryMessage.updateMany(
      { bookingId: booking._id, kind: 'scheduled', deliveryStatus: 'scheduled' },
      { $set: { deliveryStatus: 'cancelled' } },
      { session },
    );
  });
  if (!booking) return res.status(409).json({ message: 'Only upcoming bookings can be cancelled.' });
  return res.json({ booking: inquiryBookingView(booking) });
});

app.post('/api/inquiries/:id/payment-requests', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const booking = await InquiryBooking.findById(req.params.id);
  const tokenRecord = booking?.token ? await InquiryToken.findOne({
    bookingId: booking._id,
    userId: booking.userId,
    token: booking.token,
    tokenStatus: 'active',
  }).select('_id').lean() : null;
  const now = new Date();
  if (!booking || booking.status !== 'In Progress' || booking.tokenStatus !== 'active'
    || !booking.sessionStartedAt || !booking.sessionEndsAt
    || booking.sessionStartedAt > now || booking.sessionEndsAt <= now || !tokenRecord) {
    return res.status(409).json({ message: 'Payment requests can only be sent during an active conversation.' });
  }
  const amount = String(req.body?.amount ?? '').trim();
  const amountPaise = /^\d{1,7}(?:\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const description = String(req.body?.description || '').trim();
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > 100_000_000) {
    return res.status(400).json({ message: 'Enter an amount between ₹1 and ₹1,000,000.' });
  }
  if (!description || description.length > 300) {
    return res.status(400).json({ message: 'Enter a payment description of 1 to 300 characters.' });
  }
  const idempotencyKey = String(req.body?.idempotencyKey || '');
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(idempotencyKey)) {
    return res.status(400).json({ message: 'A valid payment request reference is required.' });
  }
  const subscriptionDiscount = await subscriptionDiscountForAmount(booking.userId, amountPaise);
  const payableAmountPaise = Math.max(0, amountPaise - subscriptionDiscount.amountPaise);
  if (!payableAmountPaise) return res.status(400).json({ message: 'This payment amount is too small after applying your subscription discount.' });
  const existingRequest = await InquiryPaymentRequest.findOne({ bookingId: booking._id, idempotencyKey });
  if (existingRequest) {
    const existingMessage = await InquiryMessage.findOne({ paymentRequestId: existingRequest._id });
    if (existingMessage) return res.json({ paymentRequest: inquiryPaymentSnapshot(existingRequest), message: inquiryMessageView(existingMessage) });
  }
  const mongoSession = await mongoose.startSession();
  let created;
  try {
    await mongoSession.withTransaction(async () => {
      const [paymentRequest] = await InquiryPaymentRequest.create([{
        bookingId: booking._id,
        customerId: booking.userId,
        adminId: req.session.sub,
        baseAmountPaise: amountPaise,
        amountPaise: payableAmountPaise,
        subscriptionDiscountAmountPaise: subscriptionDiscount.amountPaise,
        subscriptionDiscountPlan: subscriptionDiscount.plan,
        subscriptionDiscountPercent: subscriptionDiscount.percentage,
        description,
        idempotencyKey,
      }], { session: mongoSession });
      const [message] = await InquiryMessage.create([{
        bookingId: booking._id,
        authorId: req.session.sub,
        authorRole: 'admin',
        kind: 'chat',
        text: '',
        paymentRequestId: paymentRequest._id,
        paymentSnapshot: inquiryPaymentSnapshot(paymentRequest),
      }], { session: mongoSession });
      created = { request: paymentRequest.toObject(), message: inquiryMessageView(message) };
    });
    return res.status(201).json({ paymentRequest: inquiryPaymentSnapshot(created.request), message: created.message });
  } catch (error) {
    if (error.code === 11000) {
      const requestRecord = await InquiryPaymentRequest.findOne({ bookingId: booking._id, idempotencyKey });
      const message = requestRecord ? await InquiryMessage.findOne({ paymentRequestId: requestRecord._id }) : null;
      if (requestRecord && message) return res.json({ paymentRequest: inquiryPaymentSnapshot(requestRecord), message: inquiryMessageView(message) });
    }
    console.error('Inquiry payment request creation failed:', error.message);
    return res.status(503).json({ message: 'The payment request could not be sent. Please try again.' });
  } finally {
    await mongoSession.endSession();
  }
});

app.post('/api/inquiry-payment-requests/:id/wallet/pay', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const pin = req.body?.pin;
  if (!validatePin(pin)) return res.status(400).json({ message: 'Enter your 4-digit wallet PIN.' });
  const existingWallet = await Wallet.findOne({ userId: req.session.sub });
  if (!existingWallet) return res.status(409).json({ message: 'Create your wallet PIN first.' });
  if (existingWallet.lockedUntil && existingWallet.lockedUntil > new Date()) {
    return res.status(429).json({ message: 'Wallet is temporarily locked. Please try again later.' });
  }
  if (!verifyPin(pin, existingWallet.pinHash)) {
    existingWallet.failedPinAttempts += 1;
    if (existingWallet.failedPinAttempts >= 5) {
      existingWallet.failedPinAttempts = 0;
      existingWallet.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
    }
    await existingWallet.save();
    return res.status(401).json({ message: 'Incorrect PIN. Please try again.' });
  }
  try {
    const result = await withMongoTransaction(async (session) => {
      const paymentRequest = await InquiryPaymentRequest.findOne({
        _id: req.params.id, customerId: req.session.sub,
      }).session(session);
      if (!paymentRequest) throw Object.assign(new Error('Payment request was not found.'), { status: 404 });
      const duplicate = await InquiryPaymentAttempt.findOne({
        requestId: paymentRequest._id, method: 'Wallet', status: 'Successful',
      }).session(session).lean();
      const wallet = await Wallet.findOne({ userId: req.session.sub }).session(session);
      if (!wallet || !verifyPin(pin, wallet.pinHash)) throw Object.assign(new Error('Wallet security details changed. Verify your PIN again.'), { status: 401 });
      if (paymentRequest.status === 'Paid' && duplicate) return { paymentRequest, wallet, duplicate: true };
      if (paymentRequest.status !== 'Pending') throw Object.assign(new Error('This payment request is no longer payable.'), { status: 409 });
      const limitState = await getWalletLimitStatus(req.session.sub, wallet.balancePaise);
      const spendCheck = enforceAvailableWalletSpendLimit(wallet.balancePaise, paymentRequest.amountPaise, limitState, 'Wallet balance');
      if (!spendCheck.allowed) throw Object.assign(new Error(spendCheck.message), { status: 409, availableBalance: money(spendCheck.availableBalancePaise), restrictedBalance: money(spendCheck.restrictedBalancePaise) });
      if (wallet.balancePaise < paymentRequest.amountPaise) throw Object.assign(new Error('Insufficient wallet balance.'), { status: 402 });
      const before = wallet.balancePaise;
      const changed = await Wallet.updateOne(
        { _id: wallet._id, balancePaise: wallet.balancePaise },
        {
          $set: {
            balancePaise: wallet.balancePaise - paymentRequest.amountPaise,
            totalBalancePaise: wallet.balancePaise - paymentRequest.amountPaise,
            availableBalancePaise: Math.max(0, wallet.balancePaise - paymentRequest.amountPaise - wallet.restrictedBalancePaise),
            failedPinAttempts: 0,
          },
          $unset: { lockedUntil: 1 },
        },
        { session },
      );
      if (!changed.modifiedCount) throw Object.assign(new Error('Insufficient wallet balance.'), { status: 402 });
      wallet.balancePaise -= paymentRequest.amountPaise;
      const referenceId = `inquiry-payment:${paymentRequest._id}`;
      await WalletTransaction.create([{
        userId: req.session.sub,
        type: 'Wallet Payment',
        amountPaise: -paymentRequest.amountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: wallet.balancePaise,
        referenceId,
        description: `Inquiry payment request: ${paymentRequest.description}`,
        status: 'Successful',
      }], { session });
      paymentRequest.status = 'Paid';
      paymentRequest.paymentMethod = 'Wallet';
      paymentRequest.paymentReference = referenceId;
      paymentRequest.paidAt = new Date();
      await paymentRequest.save({ session });
      await InquiryPaymentAttempt.create([{
        requestId: paymentRequest._id, customerId: req.session.sub, method: 'Wallet',
        amountPaise: paymentRequest.amountPaise, status: 'Successful', paymentId: referenceId,
      }], { session });
      await syncInquiryPaymentMessage(paymentRequest, session);
      await InquiryMessage.create([{
        bookingId: paymentRequest.bookingId,
        authorId: 'system',
        authorRole: 'admin',
        text: `Payment of ₹${money(paymentRequest.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} received via Wallet.`,
      }], { session });
      await Notification.create([{
        userId: req.session.sub,
        message: `Your inquiry payment of ₹${money(paymentRequest.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was successful.`,
      }], { session });
      return { paymentRequest, wallet, duplicate: false };
    });
    return res.json({
      paymentRequest: inquiryPaymentSnapshot(result.paymentRequest),
      balance: money(walletAvailableBalancePaise(result.wallet)),
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === 11000) return res.status(409).json({ message: 'This payment request has already been paid.' });
    console.error('Inquiry wallet payment failed:', error.message);
    return res.status(503).json({ message: 'Wallet payment could not be completed. Please try again.' });
  }
});

app.post('/api/inquiry-payment-requests/:id/razorpay/order', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const paymentRequest = await InquiryPaymentRequest.findOne({
    _id: req.params.id, customerId: req.session.sub, status: 'Pending',
  }).lean();
  if (!paymentRequest) return res.status(404).json({ message: 'Pending payment request was not found.' });
  if (!razorpayKeyId || !razorpayKeySecret) return res.status(503).json({ message: 'Razorpay is not configured on the server.' });
  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: paymentRequest.amountPaise,
        currency: 'INR',
        receipt: `il-${String(paymentRequest._id).slice(-18)}-${Date.now().toString().slice(-8)}`,
      }),
    });
    const order = await response.json();
    if (!response.ok || !order.id) return res.status(502).json({ message: 'Razorpay could not create a payment order.' });
    await InquiryPaymentAttempt.create({
      requestId: paymentRequest._id,
      customerId: req.session.sub,
      method: 'Razorpay',
      amountPaise: paymentRequest.amountPaise,
      razorpayOrderId: order.id,
    });
    return res.json({ orderId: order.id, keyId: razorpayKeyId, amountPaise: paymentRequest.amountPaise, currency: 'INR' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'This payment attempt was already created. Please retry from the payment card.' });
    console.error('Inquiry Razorpay order creation failed:', error.message);
    return res.status(503).json({ message: 'Razorpay is temporarily unavailable.' });
  }
});

const confirmInquiryRazorpayPayment = async ({ orderId, paymentId }) => {
  const attempt = await InquiryPaymentAttempt.findOne({ razorpayOrderId: orderId, method: 'Razorpay' });
  if (!attempt) throw Object.assign(new Error('Razorpay order does not match an inquiry payment.'), { status: 404 });
  const paymentRequest = await InquiryPaymentRequest.findById(attempt.requestId);
  if (!paymentRequest) throw Object.assign(new Error('Payment request no longer exists.'), { status: 404 });
  if (attempt.status === 'Successful' && attempt.paymentId === paymentId && paymentRequest.status === 'Paid') {
    return { paymentRequest, duplicate: true };
  }
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` },
  });
  const payment = await response.json();
  if (!response.ok || payment.order_id !== orderId || payment.amount !== attempt.amountPaise
    || payment.currency !== 'INR' || payment.status !== 'captured') {
    throw Object.assign(new Error('Razorpay payment amount, currency, or capture status could not be verified.'), { status: 409 });
  }
  return withMongoTransaction(async (session) => {
    const currentRequest = await InquiryPaymentRequest.findOne({
      _id: paymentRequest._id, customerId: attempt.customerId, status: 'Pending',
    }).session(session);
    if (!currentRequest) {
      const paid = await InquiryPaymentRequest.findOne({ _id: paymentRequest._id, status: 'Paid' }).session(session);
      if (paid?.paymentReference === paymentId) return { paymentRequest: paid, duplicate: true };
      throw Object.assign(new Error('This payment request has already been processed.'), { status: 409 });
    }
    const currentAttempt = await InquiryPaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, status: 'Pending' },
      { $set: { status: 'Successful', paymentId } },
      { new: true, session },
    );
    if (!currentAttempt) throw Object.assign(new Error('This payment attempt has already been processed.'), { status: 409 });
    currentRequest.status = 'Paid';
    currentRequest.paymentMethod = 'Razorpay';
    currentRequest.paymentReference = paymentId;
    currentRequest.paidAt = new Date();
    await currentRequest.save({ session });
    await syncInquiryPaymentMessage(currentRequest, session);
    await InquiryMessage.create([{
      bookingId: currentRequest.bookingId,
      authorId: 'system',
      authorRole: 'admin',
      text: `Payment of ₹${money(currentRequest.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} received via Razorpay.`,
    }], { session });
    await Notification.create([{
      userId: currentRequest.customerId,
      message: `Your inquiry payment of ₹${money(currentRequest.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2 })} was successful.`,
    }], { session });
    return { paymentRequest: currentRequest, duplicate: false };
  });
};

app.post('/api/inquiry-payment-requests/:id/razorpay/verify', requireSession, requireDatabase, requirePurchaseAge, async (req, res) => {
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!orderId || !paymentId || !signature || !razorpayKeySecret) {
    return res.status(400).json({ message: 'Razorpay verification details are incomplete.' });
  }
  const expected = crypto.createHmac('sha256', razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return res.status(401).json({ message: 'Razorpay payment signature verification failed.' });
  }
  const attempt = await InquiryPaymentAttempt.findOne({
    requestId: req.params.id, customerId: req.session.sub, razorpayOrderId: orderId,
  });
  if (!attempt) return res.status(404).json({ message: 'Payment attempt was not found for this account.' });
  try {
    const result = await confirmInquiryRazorpayPayment({ orderId, paymentId });
    return res.json({ paymentRequest: inquiryPaymentSnapshot(result.paymentRequest), duplicate: result.duplicate });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error('Inquiry Razorpay verification failed:', error.message);
    return res.status(503).json({ message: 'Razorpay payment verification is temporarily unavailable.' });
  }
});
app.post('/api/inquiry-payment-attempts/:orderId/status', requireSession, requireDatabase, async (req, res) => {
  const status = req.body?.status;
  if (!['Failed', 'Cancelled'].includes(status)) return res.status(400).json({ message: 'A valid payment attempt status is required.' });
  const attempt = await InquiryPaymentAttempt.findOneAndUpdate(
    { razorpayOrderId: req.params.orderId, customerId: req.session.sub, status: 'Pending' },
    { $set: { status, failureMessage: status === 'Failed' ? 'Payment was not completed.' : 'Payment was cancelled by the customer.' } },
    { new: true },
  );
  if (!attempt) return res.status(404).json({ message: 'Pending payment attempt was not found.' });
  return res.json({ status: attempt.status });
});

app.post('/api/admin/inquiry-payment-requests/:id/cancel', requireSession, requireDatabase, requireAdmin, async (req, res) => {
  const paymentRequest = await InquiryPaymentRequest.findOneAndUpdate(
    { _id: req.params.id, adminId: req.session.sub, status: 'Pending' },
    { $set: { status: 'Cancelled', cancelledAt: new Date() } },
    { new: true },
  );
  if (!paymentRequest) return res.status(409).json({ message: 'Only your unpaid payment requests can be cancelled.' });
  await syncInquiryPaymentMessage(paymentRequest);
  await InquiryMessage.create({
    bookingId: paymentRequest.bookingId,
    authorId: req.session.sub,
    authorRole: 'admin',
    text: 'The pending payment request was cancelled.',
  });
  return res.json({ paymentRequest: inquiryPaymentSnapshot(paymentRequest) });
});

app.post('/api/webhooks/razorpay/inquiry-payments', requireDatabase, async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = String(req.get('x-razorpay-signature') || '');
  if (!webhookSecret || !req.rawBody || !signature) return res.sendStatus(401);
  const expected = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex');
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return res.sendStatus(401);
  }
  const event = req.body?.event;
  const payment = req.body?.payload?.payment?.entity;
  if (event === 'payment.captured' && payment?.order_id && payment?.id) {
    try {
      const paymentAmountPaise = Number(payment.amount);
      const inquiryAttempt = await InquiryPaymentAttempt.exists({ razorpayOrderId: payment.order_id });
      if (inquiryAttempt) {
        await confirmInquiryRazorpayPayment({ orderId: payment.order_id, paymentId: payment.id });
      } else {
        const checkoutAttempt = await CheckoutAttempt.findOne({
          razorpayOrderId: payment.order_id,
          totalPaise: Number.isSafeInteger(paymentAmountPaise) ? paymentAmountPaise : -1,
          currency: payment.currency,
        });
        if (checkoutAttempt && checkoutAttempt.status !== 'Completed') {
          if (checkoutAttempt.status === 'Open') {
            await CheckoutAttempt.updateOne(
              { _id: checkoutAttempt._id, status: 'Open' },
              { $set: { paymentStatus: 'Paid', paymentReference: payment.id } },
            );
          } else if (['Interrupted', 'Explicitly Cancelled'].includes(checkoutAttempt.status)) {
            await CheckoutAttempt.updateOne(
              { _id: checkoutAttempt._id, status: checkoutAttempt.status },
              { $set: {
                status: 'Payment Review',
                paymentStatus: 'Paid',
                paymentReference: payment.id,
                reason: 'A payment was captured after this checkout was exited; review or refund is required.',
              } },
            );
          }
        }
      }
    } catch (error) {
      if (error.status !== 404) {
        console.error('Inquiry Razorpay webhook processing failed:', error.message);
        return res.status(503).json({ message: 'Payment event could not be processed yet.' });
      }
    }
  }
  return res.sendStatus(200);
});

const requireInquiryParticipant = async (req, res, next) => {
  let booking = await inquiryFindParticipantBooking(req, req.params.id);
  if (!booking) return res.status(404).json({ message: 'Booking was not found or is not accessible to this account.' });
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (!isAdmin && !hasInquiryVerification(req, booking._id)) {
    return res.status(403).json({ message: 'Verify your booking token and password before opening this inquiry session.' });
  }
  const now = new Date();
  if (booking.status === 'Upcoming' && booking.slotStart <= now && booking.slotEnd > now) {
    booking = await InquiryBooking.findOneAndUpdate(
      { _id: booking._id, status: 'Upcoming', slotStart: { $lte: now }, slotEnd: { $gt: now } },
      { $set: {
        status: 'Ready',
        sessionStartedAt: booking.slotStart,
        sessionEndsAt: booking.slotEnd,
      } },
      { new: true },
    ) || booking;
  }
  req.inquiryBooking = booking;
  return next();
};
const requireInquiryActiveWindow = async (req, res, next) => {
  const booking = req.inquiryBooking;
  const now = new Date();
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (now < booking.slotStart) {
    const settings = await getInquirySettings();
    return res.status(409).json({
      message: `Your inquiry messaging opens at ${inquiryTokenAvailableAt(booking.slotStart, settings.timezone)} (${settings.timezone}).`,
      sessionState: 'scheduled',
      booking: inquiryBookingView(booking),
    });
  }
  if (now >= booking.slotEnd || booking.status !== 'In Progress'
    || !booking.sessionStartedAt || !booking.sessionEndsAt
    || now < booking.sessionStartedAt || now >= booking.sessionEndsAt
    || booking.tokenStatus !== 'active') {
    return res.status(409).json({
      message: booking.tokenStatus !== 'active'
        ? 'A valid active token is required before inquiry chat messaging can begin.'
        : now < booking.slotStart ? 'Your inquiry session has not started yet.' : 'Your inquiry session has ended.',
      sessionState: now < booking.slotStart ? 'scheduled' : 'ended',
      booking: inquiryBookingView(booking),
    });
  }
  const tokenRecord = await InquiryToken.exists({
    bookingId: booking._id,
    userId: booking.userId,
    token: booking.token,
    tokenStatus: 'active',
  });
  if (!tokenRecord) return res.status(409).json({ message: 'A valid active token is required before inquiry chat messaging can begin.' });
  if (!isAdmin && !hasInquiryVerification(req, booking._id)) {
    return res.status(403).json({ message: 'Verify your booking token and password before sending messages.' });
  }
  return next();
};
app.post('/api/inquiries/:id/schedule-message', requireSession, requireDatabase, requireInquiryParticipant, async (req, res) => {
  const booking = req.inquiryBooking;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (isAdmin || booking.userId !== req.session.sub) return res.sendStatus(403);
  if (booking.status !== 'Upcoming' && booking.status !== 'Ready') return res.status(409).json({ message: 'This booking cannot accept a scheduled message.' });
  if (new Date() >= booking.slotStart) return res.status(409).json({ message: 'The booking has started. Send a message instead.' });
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 4000) return res.status(400).json({ message: 'Enter a message of 1 to 4,000 characters.' });
  try {
    const message = await InquiryMessage.create({
      bookingId: booking._id, authorId: req.session.sub, authorRole: 'customer',
      text, kind: 'scheduled', deliveryStatus: 'scheduled',
    });
    return res.status(201).json({ message: 'Your message is scheduled.', scheduledMessage: inquiryMessageView(message) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Only one initial scheduled message is allowed per booking.' });
    console.error('Scheduling inquiry message failed:', error.message);
    return res.status(503).json({ message: 'The message could not be scheduled. Please try again.' });
  }
});
app.post('/api/inquiries/:id/messages', requireSession, requireDatabase, requireInquiryParticipant, requireInquiryActiveWindow, handleInquiryAttachmentUpload, async (req, res) => {
  const booking = req.inquiryBooking;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  const isOwner = booking.userId === req.session.sub;
  const now = new Date();
  if (!isAdmin && !isOwner) return res.sendStatus(403);
  if (booking.status !== 'In Progress' || booking.tokenStatus !== 'active' || !booking.sessionStartedAt || !booking.sessionEndsAt
    || now < booking.sessionStartedAt || now >= booking.sessionEndsAt) {
    return res.status(409).json({ message: 'Messages can only be sent during the active 30-minute session.' });
  }
  const files = req.files || [];
  const clientMessageId = String(req.body?.clientMessageId || '');
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(clientMessageId)) {
    return res.status(400).json({ message: 'A valid message reference is required.' });
  }
  const repeatedMessage = await InquiryMessage.findOne({ bookingId: booking._id, clientMessageId });
  if (repeatedMessage) return res.json({ message: inquiryMessageView(repeatedMessage) });
  if (files.length && booking.category !== 'Problem') return res.status(403).json({ message: 'Attachments are available only for Problem bookings.' });
  if (files.some((file) => !inquiryFileSignatureValid(file))) return res.status(400).json({ message: 'An attachment is not a valid supported image.' });
  const text = String(req.body?.text || '').trim();
  if ((!text && !files.length) || text.length > 4000) return res.status(400).json({ message: 'Enter a message of up to 4,000 characters or attach an image.' });
  try {
    const message = await InquiryMessage.create({
      bookingId: booking._id, authorId: req.session.sub,
      authorRole: isAdmin ? 'admin' : 'customer',
      text,
      attachments: files.map((file) => ({
        name: path.basename(file.originalname).slice(0, 120),
        mimeType: file.mimetype,
        size: file.size,
        data: file.buffer,
      })),
      clientMessageId,
    });
    return res.status(201).json({ message: inquiryMessageView(message) });
  } catch (error) {
    if (error.code === 11000) {
      const repeated = await InquiryMessage.findOne({ bookingId: booking._id, clientMessageId });
      if (repeated) return res.json({ message: inquiryMessageView(repeated) });
    }
    console.error('Inquiry message persistence failed:', error.message);
    return res.status(503).json({ message: 'The message could not be saved. Please try again.' });
  }
});
app.get('/api/inquiries/:id/messages', requireSession, requireDatabase, requireInquiryParticipant, async (req, res) => {
  const booking = req.inquiryBooking;
  const messages = await InquiryMessage.find({
    bookingId: booking._id,
    $or: [{ kind: 'chat' }, { kind: 'scheduled', deliveryStatus: 'delivered' }],
  }).sort({ createdAt: 1 }).limit(500).lean();
  return res.json({ messages: messages.map(inquiryMessageView), booking: await inquiryBookingDetails(booking) });
});
app.get('/api/inquiries/:id/stream', requireSession, requireDatabase, requireInquiryParticipant, requireInquiryActiveWindow, async (req, res) => {
  const bookingId = req.inquiryBooking._id;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  let lastMessageId = '';
  let stopped = false;
  let lastSessionCheck = 0;
  const pushUpdates = async () => {
    if (stopped || res.writableEnded) return;
    try {
      if ((req.session.exp && req.session.exp * 1000 <= Date.now()) || revokedSessionIds.has(req.session.jti)) {
        res.write('event: revoked\ndata: {}\n\n');
        res.end();
        return;
      }
      if (req.session.jti && Date.now() - lastSessionCheck >= 15_000) {
        lastSessionCheck = Date.now();
        if (await RevokedSession.exists({ sessionId: req.session.jti })) {
          res.write('event: revoked\ndata: {}\n\n');
          res.end();
          return;
        }
      }
      let booking = await InquiryBooking.findById(bookingId).lean();
      if (!booking) { res.write('event: ended\ndata: {}\n\n'); res.end(); return; }
      if (booking.status === 'In Progress' && booking.sessionEndsAt && booking.sessionEndsAt <= new Date()) {
        await InquiryBooking.updateOne(
          { _id: bookingId, status: 'In Progress', sessionEndsAt: { $lte: new Date() } },
          [{ $set: { status: 'Completed', tokenStatus: { $cond: [{ $eq: ['$tokenStatus', 'active'] }, 'completed', '$tokenStatus'] } } }],
          { updatePipeline: true },
        );
        await InquiryToken.updateOne(
          { bookingId, tokenStatus: 'active' },
          { $set: { tokenStatus: 'completed', sessionEndsAt: new Date() } },
        );
        await InquiryMessage.updateMany({ bookingId, kind: 'scheduled', deliveryStatus: 'scheduled' }, { $set: { deliveryStatus: 'cancelled' } });
        booking = await InquiryBooking.findById(bookingId).lean();
      }
      const messages = await InquiryMessage.find({
        bookingId,
        $or: [{ kind: 'chat' }, { kind: 'scheduled', deliveryStatus: 'delivered' }],
      }).sort({ createdAt: 1 }).limit(500).lean();
      const latestId = messages.length ? String(messages[messages.length - 1]._id) : '';
      if (latestId !== lastMessageId) {
        lastMessageId = latestId;
        res.write(`event: update\ndata: ${JSON.stringify({
          messages: messages.map(inquiryMessageView),
          booking: await inquiryBookingDetails(booking),
          serverTime: new Date().toISOString(),
        })}\n\n`);
      } else {
        res.write(': keep-alive\n\n');
      }
      if (booking.status !== 'In Progress' && ['Completed', 'Cancelled', 'Expired'].includes(booking.status)) {
        res.write('event: ended\ndata: {}\n\n');
        res.end();
      }
    } catch (error) {
      console.error('Inquiry live stream update failed:', error.message);
      res.write('event: error\ndata: {"message":"Live updates are temporarily unavailable."}\n\n');
    }
  };
  req.on('close', () => { stopped = true; clearInterval(timer); });
  const timer = setInterval(pushUpdates, 1500);
  await pushUpdates();
});
app.get('/api/inquiries/attachments/:attachmentId', requireSession, requireDatabase, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.attachmentId)) return res.sendStatus(404);
  const message = await InquiryMessage.findOne({ 'attachments._id': req.params.attachmentId }).select('+attachments.data');
  if (!message) return res.sendStatus(404);
  const booking = await InquiryBooking.findById(message.bookingId).lean();
  if (!booking) return res.sendStatus(404);
  const isOwner = booking.userId === req.session.sub;
  const isAdmin = req.session.admin === true && isAdminEmail(req.session.email);
  if (!isOwner && !isAdmin) return res.sendStatus(403);
  if (isOwner && !hasInquiryVerification(req, booking._id)) {
    return res.status(403).json({ message: 'Verify your booking token and password before viewing session attachments.' });
  }
  const now = new Date();
  if (!isAdmin && now < booking.slotStart) {
    return res.status(409).json({ message: `Your inquiry messaging opens at ${inquiryTokenAvailableAt(booking.slotStart, (await getInquirySettings()).timezone)}.` });
  }
  const attachment = message.attachments.id(req.params.attachmentId);
  if (!attachment) return res.sendStatus(404);
  if (attachment.data?.length) {
    res.set({ 'Content-Type': attachment.mimeType, 'Content-Length': String(attachment.data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return res.send(attachment.data);
  }
  if (!attachment.fileName) return res.status(410).json({ message: 'This attachment is no longer available.' });
  try {
    const content = await fs.readFile(path.join(legacyInquiryUploadDirectory, path.basename(attachment.fileName)));
    res.set({ 'Content-Type': attachment.mimeType, 'Content-Length': String(content.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return res.send(content);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(410).json({ message: 'This attachment is no longer available.' });
    console.error('Inquiry attachment read failed:', error.message);
    return res.status(503).json({ message: 'The attachment could not be loaded.' });
  }
});

const finalizeEndedInquirySessions = async (now) => {
  await InquiryBooking.updateMany(
    { status: 'Upcoming', slotStart: { $lte: now }, slotEnd: { $gt: now } },
    [{ $set: {
      status: 'Ready',
      sessionStartedAt: '$slotStart',
      sessionEndsAt: '$slotEnd',
    } }],
    { updatePipeline: true },
  );
  await InquiryBooking.updateMany(
    { status: { $in: ['Upcoming', 'Ready'] }, slotEnd: { $lte: now } },
    [{ $set: { status: 'Expired', tokenStatus: { $cond: [{ $eq: [{ $type: '$token' }, 'string'] }, 'completed', '$tokenStatus'] } } }],
    { updatePipeline: true },
  );
  await InquiryBooking.updateMany(
    { status: 'In Progress', sessionEndsAt: { $lte: now } },
    [{ $set: { status: 'Completed', tokenStatus: { $cond: [{ $eq: ['$tokenStatus', 'active'] }, 'completed', '$tokenStatus'] } } }],
    { updatePipeline: true },
  );
  const endedBookings = await InquiryBooking.find({
    status: { $in: ['Completed', 'Cancelled', 'Expired'] },
    tokenStatus: { $in: ['active', 'token_generated'] },
  }).distinct('_id');
  if (endedBookings.length) {
    const cancelledBookings = await InquiryBooking.find({ _id: { $in: endedBookings }, status: 'Cancelled' }).distinct('_id');
    await InquiryToken.updateMany(
      { bookingId: { $in: endedBookings }, tokenStatus: 'active' },
      { $set: { tokenStatus: 'completed', sessionEndsAt: now } },
    );
    await InquiryToken.updateMany(
      { bookingId: { $in: cancelledBookings }, tokenStatus: 'token_generated' },
      { $set: { tokenStatus: 'cancelled' } },
    );
    await InquiryToken.updateMany(
      { bookingId: { $in: endedBookings, $nin: cancelledBookings }, tokenStatus: 'token_generated' },
      { $set: { tokenStatus: 'completed' } },
    );
    await InquiryBooking.updateMany(
      { _id: { $in: endedBookings }, status: { $in: ['Completed', 'Expired'] }, token: { $type: 'string' }, tokenStatus: { $ne: 'completed' } },
      { $set: { tokenStatus: 'completed' } },
    );
  }
  await InquiryBooking.updateMany(
    { status: 'In Progress', sessionEndsAt: { $exists: false }, slotEnd: { $lte: now } },
    [{ $set: { status: 'Completed', tokenStatus: { $cond: [{ $eq: ['$tokenStatus', 'active'] }, 'completed', '$tokenStatus'] }, sessionEndsAt: '$slotEnd' } }],
    { updatePipeline: true },
  );
};
const processInquiryDueWork = async () => {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  await finalizeEndedInquirySessions(now);
  await CheckoutAttempt.updateMany(
    {
      status: 'Open',
      paymentStatus: { $ne: 'Paid' },
      updatedAt: { $lte: new Date(now.getTime() - 30 * 60 * 1000) },
    },
    [{
      $set: {
        status: 'Interrupted',
        reason: 'Checkout activity stopped without a confirmed exit.',
        exitedAt: now,
      },
    }],
    { updatePipeline: true },
  );
  await CheckoutAttempt.updateMany(
    {
      status: 'Open',
      paymentStatus: 'Paid',
      updatedAt: { $lte: new Date(now.getTime() - 30 * 60 * 1000) },
    },
    [{
      $set: {
        status: 'Payment Review',
        reason: 'A payment was captured but no completed order is linked to this checkout.',
        exitedAt: now,
      },
    }],
    { updatePipeline: true },
  );
  await CheckoutAttempt.updateMany(
    {
      status: 'Completing',
      updatedAt: { $lte: new Date(now.getTime() - 5 * 60 * 1000) },
    },
    [{
      $set: {
        status: 'Payment Review',
        reason: 'Order finalization was interrupted after a payment was captured.',
      },
    }],
    { updatePipeline: true },
  );
  await InquiryMessage.updateMany(
    { kind: 'scheduled', deliveryStatus: 'scheduled', bookingId: { $in: await InquiryBooking.find({ status: { $in: ['Cancelled', 'Expired', 'Completed'] } }).distinct('_id') } },
    { $set: { deliveryStatus: 'cancelled' } },
  );
  const activeBookingIds = await InquiryBooking.find({
    status: 'In Progress',
    tokenStatus: 'active',
    slotStart: { $lte: now },
    slotEnd: { $gt: now },
  }).distinct('_id');
  const due = activeBookingIds.length
    ? await InquiryMessage.find({
      bookingId: { $in: activeBookingIds },
      kind: 'scheduled',
      deliveryStatus: 'scheduled',
    }).select('_id bookingId').limit(100).lean()
    : [];
  for (const message of due) {
    await withMongoTransaction(async (session) => {
      const bookingIsActive = await InquiryBooking.exists({
        _id: message.bookingId,
        status: 'In Progress',
        tokenStatus: 'active',
        slotStart: { $lte: now },
        slotEnd: { $gt: now },
      }).session(session);
      if (!bookingIsActive) return;
      await InquiryMessage.updateOne(
        { _id: message._id, deliveryStatus: 'scheduled' },
        { $set: { deliveryStatus: 'delivered' } },
        { session },
      );
    });
  }
};
const processSubscriptionLifecycle = async () => {
  if (mongoose.connection.readyState !== 1) return;
  await processAllDueRenewals();
  const now = new Date();
  const expiredUsers = await Subscription.distinct('userId', {
    status: 'active',
    expiryDate: { $lte: now },
  });
  await Promise.all(expiredUsers.map((userId) => currentSubscription(userId)));
  const usersWithExpiredPlans = await Subscription.distinct('userId', {
    status: { $in: ['expired', 'renewal_failed'] },
    expiryDate: { $lte: now },
  });
  await Promise.all(usersWithExpiredPlans.map(async (userId) => {
    await getSubscriptionGraceState(userId);
    await syncWalletRestrictionState(userId);
  }));
};
const subscriptionLifecycleScheduler = setInterval(() => {
  processSubscriptionLifecycle().catch((error) => console.error('Subscription lifecycle processing failed:', error.message));
}, 10_000);
subscriptionLifecycleScheduler.unref();
const inquiryScheduler = setInterval(() => {
  processInquiryDueWork().catch((error) => console.error('Inquiry scheduler failed:', error.message));
}, 10_000);
inquiryScheduler.unref();
mongoose.connection.once('connected', () => {
  processInquiryDueWork().catch((error) => console.error('Inquiry scheduler startup recovery failed:', error.message));
  processSubscriptionLifecycle().catch((error) => console.error('Subscription lifecycle startup recovery failed:', error.message));
});

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(frontendBuildPath, 'app.html'), (error) => {
    if (error) {
      console.error('Frontend route could not be served:', error.message);
      return next(error);
    }
    return undefined;
  });
});

if (process.env.NODE_ENV === 'production') {
  const configurationErrors = [];
  if (!process.env.MONGODB_URI) configurationErrors.push('MONGODB_URI must be configured.');
  if (!sessionSecret || sessionSecret.length < 32) configurationErrors.push('SESSION_SECRET must contain at least 32 characters.');
  if (configurationErrors.length) {
    console.error(`Production configuration error: ${configurationErrors.join(' ')}`);
    process.exit(1);
  }
}

app.listen(port, () => console.log(`Auth server listening on port ${port}`));

if (!process.env.MONGODB_URI) {
  databaseDiagnostic = { state: 'disconnected', errorType: 'configuration' };
  console.warn('MONGODB_URI is not configured; database-backed features and sign-in are unavailable.');
} else {
  mongoose.connect(process.env.MONGODB_URI)
      .then(async () => {
        await loadSubscriptionPlanSettings();
        await ensureInquiryTokenIndexes();
        await migrateLegacyInquiryAttachments();
        await ensureProductSearchHistoryIndexes();
        databaseDiagnostic = { state: 'connected', errorType: null };
        console.log('MongoDB connection status: connected');
        return seedInventory();
    })
    .catch((error) => {
      databaseDiagnostic = { state: 'disconnected', errorType: classifyDatabaseError(error) };
      console.error(`MongoDB connection failed. Error type: ${databaseDiagnostic.errorType}`);
      if (process.env.NODE_ENV === 'production') process.exit(1);
      console.warn('Continuing in development with database-backed features unavailable.');
    });
}