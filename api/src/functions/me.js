const { endpoint } = require("../shared/endpoint");

// Who is signed in, and what they can do.
endpoint("me", { methods: ["GET"], route: "me" }, async (request, context, user) => {
  return { jsonBody: user };
});
