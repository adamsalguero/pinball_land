const AMENITIES = [
  {
    id: "arcade",
    headline: "2-story arcade",
    body: "Access one of California’s largest private collections of pinball machines and arcade games—unlimited play for all guests. Dive into an immersive entertainment experience like no other.",
    photo: "arcade",
  },
  {
    id: "oasis",
    headline: "Outdoor Oasis",
    body: "Step into a serene outdoor space with lush gardens, a fountain, and an outdoor bar. Perfect for intimate gatherings or outdoor events, our space blends natural beauty with modern comfort.",
    photo: "oasis",
  },
  {
    id: "events",
    headline: "Flexible Event Options",
    body: "Host anything from family celebrations and Charity Fundraisers to financial seminars and small private functions. Our space is designed to be flexible and can be tailored to meet your unique needs.",
    eventTypes:
      "Retirement Gatherings | Charity Fundraisers | Birthday Parties | Client Appreciation Events | Financial Seminars | Team Building Events | Holiday Parties & More",
    photo: null,
  },
];

const AMENITY_IDS = AMENITIES.map((item) => item.id);

function getAmenity(id) {
  return AMENITIES.find((item) => item.id === id) || null;
}

module.exports = { AMENITIES, AMENITY_IDS, getAmenity };
