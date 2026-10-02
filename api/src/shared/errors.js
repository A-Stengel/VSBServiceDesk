// An error whose message is safe to show the user, with the HTTP status to send.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
