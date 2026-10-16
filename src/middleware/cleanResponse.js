function cleanResponse(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'message')) {
      const { message, ...response } = body;
      return json(response);
    }

    return json(body);
  };

  return next();
}

module.exports = cleanResponse;
