import { Link, useLocation } from 'react-router-dom';
import { useLayoutEffect } from 'react';

const policySections = [
  {
    id: 'account-policy',
    title: '1. Account and User Responsibilities Policy',
    paragraphs: [
      'Users must provide accurate information when creating an account or placing an order.',
      'Users are responsible for maintaining the confidentiality of their account credentials and wallet PIN.',
      "Users must not attempt to access another person's account without permission.",
      'Innovation Labs reserves the right to restrict accounts involved in fraudulent transactions, misuse or violations of these terms.',
      'Users must ensure that their contact details and delivery information are correct.',
    ],
  },
  {
    id: 'subscription-policy',
    title: '2. Subscription Plans and Expiration Policy',
    paragraphs: [
      'Innovation Labs offers different subscription plans, including Starter, Plus, Pro and Exclusive. Each subscription plan provides specific benefits, AI usage allowances, wallet limits and other features.',
      'Subscription benefits depend on the selected plan.',
      'Paid subscriptions remain active for the purchased subscription duration.',
      'When a paid subscription expires, the account automatically moves to the Starter plan unless another eligible subscription is purchased.',
      'The benefits, AI usage allowances and wallet limits of the previous subscription will no longer apply after expiration.',
      "Subscription expiration does not automatically mean that the user's entire wallet balance is lost.",
      'The wallet restriction policy described below will apply when the subscription expires.',
    ],
  },
  {
    id: 'grace-period-policy',
    title: '3. Subscription Expiration and 48-Hour Grace Period Policy',
    paragraphs: [
      'After a paid subscription expires, Innovation Labs provides a 48-hour renewal grace period.',
      'During this period, the customer can renew or upgrade their subscription; the website may display subscription-expiration reminders; the customer can review the amount that may become restricted if the grace period expires; and the customer can purchase an eligible subscription to maintain or increase their wallet limit.',
      'If the customer does not renew or upgrade before the 48-hour grace period expires, the applicable wallet restriction will be implemented.',
      "The restriction will be calculated according to the wallet limit of the customer's current subscription plan.",
    ],
  },
  {
    id: 'wallet-limit-policy',
    title: '4. Wallet Limit and Restricted Balance Policy',
    paragraphs: [
      'Each subscription plan has a maximum permitted wallet balance.',
      'When a subscription expires and the account moves to a plan with a lower wallet limit, the wallet balance may exceed the newly applicable limit.',
      "The excess amount will be restricted after the 48-hour grace period. It will be deducted from the available wallet balance and maintained separately as a restricted wallet balance in Innovation Labs' records.",
      'Restricted funds cannot be used for purchases, transfers, recharges or other wallet transactions while restricted.',
      'The restricted amount is not permanently forfeited merely because the subscription expired.',
      'The customer can regain access to the eligible restricted amount by purchasing a subscription with a sufficient wallet limit.',
      'After successful subscription payment and activation, the system will automatically recalculate the wallet limit and restore the amount that is eligible to be unlocked.',
      "If the new subscription limit is still lower than the customer's total wallet balance, the remaining excess amount will continue to remain restricted.",
      'Example: Original wallet balance ₹10,090; new Starter wallet limit ₹5,000; restricted amount ₹5,090. If the customer subsequently purchases Pro with a ₹15,000 wallet limit, the previously restricted ₹5,090 will be restored because the total wallet balance is within the new limit.',
      "Innovation Labs will maintain records of wallet restrictions and restorations in the customer's wallet transaction history.",
    ],
  },
  {
    id: 'wallet-transaction-policy',
    title: '5. Wallet Transaction Policy',
    paragraphs: [
      'Wallet transactions must be authorized through the applicable security verification process.',
      'Wallet deductions will occur only after successful transaction authorization.',
      'Failed transactions must not result in duplicate deductions.',
      'Wallet transaction history will record purchases, refunds, recharges, transfers, restrictions and restorations.',
      'Restricted wallet funds cannot be transferred or spent.',
      'Wallet balances and transaction records are maintained electronically.',
      'Users should contact Innovation Labs if they identify an incorrect wallet transaction.',
    ],
  },
  {
    id: 'order-payment-policy',
    title: '6. Product Order and Payment Policy',
    paragraphs: [
      'Customers must review their selected products, quantities and prices before confirming an order.',
      'Product availability depends on the stock displayed at the time of ordering.',
      'An order is considered successfully placed after the applicable payment and order-confirmation process is completed.',
      'Admin acceptance is a separate stage of order processing.',
      'Product prices may change over time. However, an already confirmed order must retain the applicable purchase price recorded for that order.',
      'Customers must review delivery charges, additional charges and the selected package before making payment.',
    ],
  },
  {
    id: 'cancellation-policy',
    title: '7. Order Cancellation Policy',
    paragraphs: [
      "Cancellation eligibility depends on the product's cancellation settings and the current order status.",
      'Products marked as Cancellable may be cancelled only while the order remains eligible for cancellation.',
      'Products marked as Non-Cancellable cannot be cancelled by the customer.',
      'Once an order has been accepted by the admin, customer cancellation is no longer available through the normal cancellation process.',
      'Products marked Non-Cancellable remain subject to this restriction even if the admin has not yet accepted the order.',
      'For orders containing multiple products, cancellation eligibility is determined separately for each product.',
      'If an order contains both cancellable and non-cancellable products, only eligible products may be cancelled.',
      'Cancellation requests must be verified by the system before the cancellation is processed.',
    ],
  },
  {
    id: 'non-cancellable-policy',
    title: '8. Non-Cancellable Product Policy',
    paragraphs: [
      'Certain products may be designated as Non-Cancellable by Innovation Labs.',
      'The cancellation status will be displayed on the relevant product page before the customer places an order.',
      'By placing an order for a product explicitly marked Non-Cancellable, the customer acknowledges that the product cannot be cancelled through the normal customer cancellation facility; the customer will not see a Cancel Order button for that product; and, for mixed orders, the cancellation and refund eligibility of other products will be determined independently.',
      'This restriction does not remove any rights that customers may have under applicable consumer protection laws.',
    ],
  },
  {
    id: 'refund-policy',
    title: '9. Refund Policy',
    subsections: [
      {
        title: 'A. Admin-Declined Orders',
        paragraphs: [
          'If Innovation Labs declines an order after payment has been received, the customer is entitled to a refund of the entire amount paid for that declined order.',
          'This includes the product amount, delivery charges, coding charges and other charges collected for that order.',
          'No cancellation deductions will be applied merely because Innovation Labs declined the order.',
        ],
      },
      {
        title: 'B. Customer-Cancelled Orders',
        paragraphs: [
          'If a customer cancels eligible products, the refund is limited to the paid product charges for those cancelled products, less any discount allocated to them.',
          'Delivery, coding and building charges are not refunded for customer-initiated cancellations.',
          'The refund calculation uses the prices and charges recorded when the order was placed.',
        ],
      },
      {
        title: 'C. Mixed Orders',
        paragraphs: [
          'If an order contains cancellable and non-cancellable products, refunds will be calculated only for eligible cancelled products.',
          'Non-cancellable products will not be included in the customer cancellation refund.',
          'Delivery, coding and building charges are not refunded when a customer cancels eligible products.',
        ],
      },
      {
        title: 'D. Refund Method',
        paragraphs: [
          'Refunds will be processed through the applicable original payment method or another supported refund method.',
          'Wallet-paid purchases will be refunded to the Innovation Labs Wallet where applicable.',
          'The applicable refund eligibility and calculation rules are the same whether the original payment was made using the Innovation Labs Wallet or Razorpay.',
          'Refund processing times may depend on the payment provider and banking system.',
        ],
      },
    ],
  },
  {
    id: 'subscription-payment-policy',
    title: '10. Subscription Payment and Renewal Policy',
    paragraphs: [
      'Customers can select an available subscription duration before payment.',
      'The total subscription amount is calculated by multiplying the monthly subscription price by the selected number of months.',
      'Subscription activation occurs only after successful payment confirmation.',
      'A failed or incomplete payment must not activate the subscription.',
      'The subscription starting and expiry dates will be displayed before payment confirmation.',
      'Subscription benefits will be applied according to the purchased plan and duration.',
      'Wallet restriction restoration will be processed according to the Wallet Limit and Restricted Balance Policy.',
    ],
  },
  {
    id: 'ai-policy',
    title: '11. AI Usage and AI Bill Policy',
    paragraphs: [
      "AI usage allowances depend on the customer's active subscription plan.",
      'Each plan provides a defined number of AI bills per applicable billing period.',
      'Additional AI bills, where available, may be purchased at the displayed price.',
      'Unused AI allowances are subject to the applicable billing-period rules.',
      'When a subscription expires, AI access and allowances will follow the benefits of the currently active plan.',
      'Innovation Labs may update AI features, subject to applicable customer entitlements and the terms displayed for the relevant subscription.',
    ],
  },
  {
    id: 'promotional-code-policy',
    title: '12. Promotional Code Policy',
    paragraphs: [
      'Promotional codes are subject to their individual validity periods and conditions.',
      'A promotional code must be entered correctly to receive the applicable benefit.',
      'A code that has expired, already been redeemed or is otherwise invalid cannot be used.',
      'Sold promotional codes are non-refundable, except where required by applicable law.',
      'Promotional offers cannot be exchanged for cash unless explicitly stated.',
      'Innovation Labs may reject promotional-code misuse or fraudulent redemption.',
    ],
  },
  {
    id: 'gift-card-policy',
    title: '13. Gift Card Policy',
    paragraphs: [
      'Gift cards are valid only until their displayed expiry date.',
      'Expired gift cards cannot be redeemed.',
      'Gift cards are non-refundable, except where required by applicable law.',
      'Customers must keep their gift card details secure.',
      'Gift cards must be redeemed according to their displayed conditions.',
    ],
  },
  {
    id: 'delivery-policy',
    title: '14. Delivery and Estimated Arrival Policy',
    paragraphs: [
      'Estimated delivery dates are displayed according to the information available when an order is processed.',
      'The estimated delivery date may change due to operational, logistical or external circumstances.',
      'The My Orders page displays the applicable delivery estimate.',
      'The arrival status is updated automatically according to the delivery-status rules implemented by Innovation Labs.',
      'An estimated delivery date is not an unconditional guarantee of physical delivery at a particular time.',
    ],
  },
  {
    id: 'product-safety-policy',
    title: '15. Product Package and Safety Information',
    paragraphs: [
      'Customers must review the selected product package before confirming payment.',
      'The available package options and their descriptions will be displayed during checkout.',
      'Customers are responsible for reviewing the package details and understanding the included materials and packaging.',
      'Any product-specific safety warnings must be reviewed before use.',
    ],
  },
  {
    id: 'inquiry-policy',
    title: '16. Customer Inquiry and Booking Policy',
    paragraphs: [
      'Customers must provide accurate booking information.',
      'Booking confirmation and token generation are separate operations.',
      'Saving a booking does not automatically generate a token.',
      'Customers may generate their token after successfully saving their booking, according to the available booking system.',
      'Communication through the booking chat will become available according to the booked time slot.',
      'Customers must keep their generated token and associated password confidential.',
    ],
  },
  {
    id: 'account-security-policy',
    title: '17. Account Security and Administration',
    paragraphs: [
      'Customers must not share their passwords, wallet PINs or private account credentials.',
      'Innovation Labs uses administrative controls to manage orders, inventory, subscriptions and promotional offers.',
      'Administrative actions must be performed through authorized accounts.',
      'Incorrect or unauthorized transactions should be reported promptly.',
    ],
  },
  {
    id: 'policy-updates',
    title: '18. Policy Updates',
    paragraphs: [
      'Innovation Labs may update these Terms & Conditions and Policies when its services, products or operational requirements change.',
      'Any material changes will be communicated through appropriate website notifications.',
      'Updated policies will display their latest revision date.',
      'Customers should review this page periodically.',
    ],
  },
  {
    id: 'contact-policy',
    title: '19. Contact and Customer Support',
    paragraphs: [
      'For questions concerning subscriptions, wallet restrictions, orders, payments, cancellations or refunds, customers may contact Innovation Labs through the official Inquiry section of the website.',
      'Website: innovationlabs.in',
    ],
  },
  {
    id: 'age-policy',
    title: 'Age Policy',
    paragraphs: [
      'Customers must be at least 18 years old to place orders and make purchases through Innovation Labs.',
      'By proceeding with a purchase, the customer confirms that they meet the minimum age requirement and are legally eligible to enter into the transaction.',
      'Accounts belonging to customers who do not meet the applicable purchase-age requirement must not be permitted to complete purchases.',
      'Innovation Labs may request appropriate verification when necessary and permitted by applicable law.',
      'This age requirement does not override any additional legal restrictions that may apply to particular products or services.',
      'For this implementation, purchase eligibility is based on the date of birth supplied by the account holder. This is a customer declaration and is not independent identity verification.',
    ],
  },
  {
    id: 'money-transfer-policy',
    title: 'Money Transfer Policy',
    paragraphs: [
      "Customers must carefully verify the recipient's identity and payment details before confirming a money transfer.",
      'A transfer submitted using incorrect recipient details may result in funds being credited to the wrong recipient.',
      'Customers should contact Innovation Labs support as soon as possible if they identify an incorrect transfer.',
      'Innovation Labs will review reported transfer issues and provide assistance where possible, subject to the transaction status, available records, applicable payment-provider procedures, and applicable law.',
      'However, recovery of funds transferred to an incorrect recipient cannot be guaranteed. A completed transfer may not be reversible without the necessary authorization or cooperation of the relevant parties.',
      'Innovation Labs will not promise recovery of funds in cases where recovery is outside its control. This does not remove any rights or responsibilities that apply under applicable law.',
      'Customers should review all transfer information before authorizing a transaction.',
    ],
  },
  {
    id: 'additional-order-policy',
    title: 'Order Policy',
    paragraphs: [
      'When a customer places an order successfully, the order is recorded in the Innovation Labs system and made available to the admin for review.',
      'The order must be treated as pending or processing until the applicable order workflow is completed.',
      'The admin can review the order and accept or decline it according to the existing order process.',
      'When an order is accepted by the admin, the customer-facing cancellation option will no longer be available where required by the existing order rules.',
      "If Innovation Labs declines an eligible order that has already been paid for, the full amount actually paid will be credited to the customer's Innovation Labs Wallet, whether the original payment was made using Wallet or Razorpay.",
      'Customers can view their genuine orders and relevant order statuses in their account.',
      'An abandoned checkout or an order attempt that was never successfully placed is not a completed order and must not appear as a successful purchase.',
      'An order confirmation should only be displayed after the backend has successfully recorded the order.',
    ],
  },
  {
    id: 'history-policy',
    title: 'Website History Policy',
    subsections: [
      {
        title: '1. Desktop and Laptop Browsing History',
        paragraphs: ['When a customer moves the mouse pointer over a product card on a desktop or laptop, the product may be recorded in their Browsing History. This includes interaction with the product image, name, price, or any other area of the product card.'],
      },
      {
        title: '2. Mobile Browsing History',
        paragraphs: ['On mobile devices, a product is recorded in Browsing History when the customer taps and opens its product card.'],
      },
      {
        title: '3. Product Search History',
        paragraphs: ['Search queries entered and applied in the All Products search box are recorded in Search History. This allows customers to revisit previous product searches.'],
      },
      {
        title: '4. History Storage',
        paragraphs: ["Browsing and search history are associated with the customer's account and stored securely in the Innovation Labs database."],
      },
      {
        title: '5. History Management',
        paragraphs: ['Customers can view their browsing and search history and remove individual entries or clear their history using the available History controls.'],
      },
      {
        title: '6. Privacy',
        paragraphs: ['Innovation Labs records only the product browsing and product-search activity described in this policy. It does not record passwords, wallet PINs, payment credentials, or private messages as product-search history.'],
      },
      {
        title: '7. History and Orders Are Separate',
        paragraphs: ['Browsing history and search history are separate from order history, payment history, and wallet transaction records. Clearing browsing or search history does not cancel orders or delete financial records.'],
      },
    ],
  },
  {
    id: 'minimum-age-eligibility-policy',
    title: '20. Minimum Age Requirement and Account Eligibility',
    subsections: [{
      title: 'Minimum Age Requirement',
      paragraphs: [
        'Innovation Labs is intended exclusively for individuals who are at least 18 years old.',
        'By creating an account, signing in or using the services of Innovation Labs, users confirm that they meet the minimum age requirement.',
        'All newly registered users must complete mandatory date-of-birth verification before accessing the website services.',
        'Users whose date of birth indicates that they are below 18 years of age will have their accounts restricted.',
        'Restricted users will not be permitted to access shopping, ordering, payment, wallet, subscription or other protected website services.',
        'Innovation Labs reserves the right to restrict accounts where age eligibility cannot be verified or where inaccurate age information is suspected.',
      ],
    }],
  },
  {
    id: 'age-reactivation-policy',
    title: '21. Age Verification and Account Reactivation',
    subsections: [{
      title: 'Age Verification and Account Reactivation Policy',
      paragraphs: [
        "All users must provide their date of birth through the website's mandatory age-verification process.",
        'The system calculates the user age using the date of birth provided.',
        'Users who are at least 18 years old will be permitted to access Innovation Labs after successful verification.',
        'Users below 18 years of age will have their accounts restricted.',
        'A restricted account may be reviewed by an authorised administrator.',
        'If an administrator reactivates an account, the user will be required to complete age verification again.',
        'Reactivation does not automatically grant access to the website. Access will only be restored after the user successfully satisfies the minimum age requirement.',
      ],
    }],
  },
  {
    id: 'subscription-wallet-restriction-policy',
    title: '22. Subscription Expiration and Wallet Balance Restriction',
    subsections: [{
      title: 'Subscription Expiration and Wallet Balance Policy',
      paragraphs: [
        'Each Innovation Labs subscription plan has a specific wallet balance limit: Starter ₹5,000; Plus ₹10,000; Pro ₹15,000; and Exclusive ₹20,000.',
        'When a paid subscription expires, the user account will move to the Starter plan unless another subscription is successfully activated.',
        'A 48-hour renewal grace period is provided after subscription expiration.',
        'During the grace period, users will be notified that their subscription has expired and that their wallet balance may be restricted according to the Starter plan limit.',
        'If the wallet balance exceeds the applicable limit after the grace period ends, the excess amount will be moved into a restricted wallet balance.',
        'Restricted amounts are not available for purchases, transfers, recharges or other wallet transactions.',
        'Innovation Labs retains restricted amounts as a wallet restriction, not as a forfeiture or deletion of customer funds, and maintains a record of the restricted amount.',
      ],
    }],
  },
  {
    id: 'restricted-wallet-release-policy',
    title: '23. Release of Restricted Wallet Balance After Subscription Renewal',
    subsections: [{
      title: 'Release of Restricted Wallet Balance',
      paragraphs: [
        'If a customer purchases or renews a subscription that provides a higher wallet balance limit, previously restricted amounts will be released to the available wallet balance, subject to the newly applicable limit.',
        'For example, if the original balance is ₹10,090 and the Starter limit is ₹5,000, ₹5,090 is restricted and ₹5,000 remains available. If the customer subsequently purchases Pro with a ₹15,000 limit, the ₹5,090 restricted amount is released and the available balance becomes ₹10,090.',
        'If the new subscription limit remains lower than the total wallet balance, the remaining excess continues to be restricted.',
        'Restricted wallet funds are not permanently deleted or lost. Restrictions and releases are recorded in MongoDB Atlas and displayed in Wallet History.',
      ],
    }],
  },
  {
    id: 'subscription-duration-policy',
    title: '24. Subscription Purchases and Duration',
    subsections: [{
      title: 'Subscription Purchase and Duration Policy',
      paragraphs: [
        'Customers may purchase eligible subscription plans for different durations. Available duration and total subscription price are displayed before payment.',
        'The total subscription price is calculated by multiplying the monthly subscription price by the selected number of months.',
        'A subscription becomes active only after successful payment confirmation.',
        'The subscription starting date, expiration date, selected plan, duration and payment information are recorded in the customer account.',
        'Customers can view their subscription information through their account.',
      ],
    }],
  },
  {
    id: 'subscription-expiration-notifications-policy',
    title: '25. Subscription Expiration Notifications',
    subsections: [{
      title: 'Subscription Expiration Notification Policy',
      paragraphs: [
        'Innovation Labs may notify customers when subscriptions are approaching expiration or have expired.',
        'After expiration, customers will be informed about the 48-hour renewal grace period and applicable wallet restrictions.',
        'If a subscription is not renewed before the grace period ends, applicable wallet restrictions take effect automatically.',
        'The system displays subscription and wallet information based on the recorded account and transaction data.',
      ],
    }],
  },
];

export default function PoliciesPage() {
  const location = useLocation();
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    if (location.hash) window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  }, [location.pathname]);

  return (
    <main className="page-shell policies-page">
      <div className="container policies-layout">
        <header className="policies-heading">
          <span className="eyebrow">INNOVATION LABS / CUSTOMER INFORMATION</span>
          <h1 id="terms">Terms &amp; Conditions and Policies</h1>
          <p>Last Updated: 1 November 2026</p>
          <p>Welcome to Innovation Labs. By creating an account, purchasing products, subscribing to a membership plan, using our wallet or placing an order, you agree to the following Terms &amp; Conditions and Policies. Please read these terms carefully before using our services.</p>
        </header>
        <aside className="policies-toc" aria-label="Policies and terms contents">
          <h2>On this page</h2>
          <a href="#policies">Policies</a>
          {policySections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
          <a href="#customer-acknowledgement">Customer Acknowledgement</a>
        </aside>
        <div className="policies-content">
          <div className="policy-section-divider" id="policies"><span className="eyebrow">POLICIES</span></div>
          {policySections.map((section) => (
            <section className="policy-section" id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.subsections?.map((subsection) => (
                <div className="policy-subsection" key={subsection.title}>
                  <h3>{subsection.title}</h3>
                  {subsection.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                </div>
              ))}
            </section>
          ))}
          <section className="policy-section" id="customer-acknowledgement">
            <h2>Customer Acknowledgement</h2>
            <p>By creating an account, purchasing products or subscribing to a plan, customers acknowledge that they have been provided an opportunity to review the applicable Terms &amp; Conditions and Policies.</p>
            <p>Customers must be able to access these policies before completing a purchase.</p>
          </section>
          <p className="policies-review-note">These policies are provided for customer information and should be reviewed by qualified counsel for applicable Indian legal requirements before production use. They do not remove any rights customers may have under applicable law.</p>
          <Link className="secondary-btn small" to="/">Back to Innovation Labs</Link>
        </div>
      </div>
    </main>
  );
}
