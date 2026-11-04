export default function AboutUsPage() {
  const offerings = [
    {
      number: '01',
      title: 'Electronic Components',
      description: 'Explore electronic components and hardware required for different projects.',
    },
    {
      number: '02',
      title: 'AI-Powered Tools',
      description: 'Discover intelligent tools that help users explore and develop project ideas.',
    },
    {
      number: '03',
      title: 'Project Solutions',
      description: 'Find components and resources for your electronics projects.',
    },
    {
      number: '04',
      title: 'Convenient Shopping',
      description: 'Browse products, manage orders, and enjoy a convenient purchasing experience.',
    },
    {
      number: '05',
      title: 'Customer Support',
      description: 'Contact us through our inquiry system for assistance and communication.',
    },
  ];

  return (
    <main className="page-shell about-us-page">
      <div className="container about-us-container">
        <section className="about-us-hero" aria-labelledby="about-us-title">
          <div className="about-us-intro">
            <span className="eyebrow">ABOUT INNOVATION LABS</span>
            <h1 id="about-us-title">About Innovation Labs</h1>
            <p className="about-us-welcome">Welcome to Innovation Labs!</p>
            <p>
              Innovation Labs is a platform created for people who are passionate about
              electronics, technology, creativity, and innovation.
            </p>
            <p>
              Our goal is to make electronics and project development more accessible by
              bringing useful electronic components, innovative tools, and AI-powered
              features together in one place.
            </p>
            <p>
              Whether you are exploring electronics, working on a new project, or looking
              for the components needed to bring an idea to life, Innovation Labs aims to
              provide a convenient platform for your journey.
            </p>
          </div>
          <div className="about-us-visual" aria-hidden="true">
            <div className="about-us-visual-grid" />
            <div className="about-us-visual-orbit about-us-visual-orbit-one" />
            <div className="about-us-visual-orbit about-us-visual-orbit-two" />
            <div className="about-us-visual-core"><span>I</span></div>
            <span className="about-us-visual-label">IDEAS INTO REALITY</span>
            <span className="about-us-visual-node about-us-visual-node-one" />
            <span className="about-us-visual-node about-us-visual-node-two" />
            <span className="about-us-visual-node about-us-visual-node-three" />
          </div>
        </section>

        <section className="about-us-mission" aria-labelledby="about-us-mission-title">
          <div className="about-us-section-heading">
            <span className="eyebrow">WHY WE’RE HERE</span>
            <h2 id="about-us-mission-title">Our Mission</h2>
          </div>
          <div className="about-us-mission-copy">
            <p>
              Our mission is to encourage creativity, support innovation, and make
              technology more accessible.
            </p>
            <p>
              We believe that every great invention begins with an idea. Our goal is to
              help people take their ideas one step closer to reality.
            </p>
          </div>
        </section>

        <section className="about-us-offerings" aria-labelledby="about-us-offerings-title">
          <div className="about-us-section-heading">
            <span className="eyebrow">BUILT FOR YOUR NEXT PROJECT</span>
            <h2 id="about-us-offerings-title">What We Offer</h2>
          </div>
          <div className="about-us-offering-grid">
            {offerings.map((offering) => (
              <article className="about-us-offering-card" key={offering.number}>
                <span className="about-us-offering-number" aria-hidden="true">{offering.number}</span>
                <h3>{offering.title}</h3>
                <p>{offering.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="about-us-developer" aria-labelledby="about-us-developer-title">
          <span className="about-us-developer-mark" aria-hidden="true">IL</span>
          <div>
            <span className="eyebrow">THE PERSON BEHIND THE PLATFORM</span>
            <h2 id="about-us-developer-title">Website Developer</h2>
            <p>Innovation Labs is developed by <strong>Ankit Bhattacharya</strong>.</p>
            <p>
              The website has been created with the vision of bringing electronics,
              technology, and innovation together on one platform.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
