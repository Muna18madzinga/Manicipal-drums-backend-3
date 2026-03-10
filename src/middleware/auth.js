// Authentication middleware
async function authenticate(request, reply) {
  try {
    // TEMPORARILY DISABLED FOR TESTING - Always set mock planner user
    console.log('🔓 Authentication disabled for testing - setting mock planner user');

    request.user = {
      id: '64c4a21a-4f7f-4893-8a91-4c0d32cc5c4e',
      email: 'planner@vungurdc.gov.zw',
      name: 'Vungu Planner',
      role: 'planner',
      organization: 'Vungu Rural District Council'
    }

    return; // Skip all authentication logic

    /* ORIGINAL AUTHENTICATION CODE - COMMENTED OUT FOR TESTING
    const authHeader = request.headers.authorization

    if (!authHeader) {
      return reply.code(401).send({ error: 'No authorization header provided' })
    }

    // For now, simple token validation (we'll implement proper JWT later)
    const token = authHeader.replace('Bearer ', '')

    if (token !== 'mock-jwt-token') {
      return reply.code(401).send({ error: 'Invalid token' })
    }

    // Mock user data (will be extracted from JWT in real implementation)
    request.user = {
      id: 'admin-id',
      email: 'admin@vungu.gov.zw',
      name: 'Admin User',
      role: 'admin',
      organization: 'Vungu RDC'
    }
    */

  } catch (error) {
    return reply.code(401).send({ error: 'Authentication failed' })
  }
}

// Role-based authorization
function authorize(roles) {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'User not authenticated' })
    }
    
    if (roles && !roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' })
    }
  }
}

module.exports = { authenticate, authorize }
