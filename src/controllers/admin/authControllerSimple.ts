import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';

export class AuthController {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  login = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { email, password } = request.body as any;

      // Simple validation
      if (!email || !password) {
        reply.status(400).send({
          error: 'Missing credentials',
          message: 'Email and password are required'
        });
        return;
      }

      // TODO: Implement actual authentication logic
      // For now, return a mock response
      reply.send({
        data: {
          token: 'mock-jwt-token',
          refreshToken: 'mock-refresh-token',
          user: {
            id: 1,
            email: email,
            role: 'super_admin',
            permissions: ['users.create', 'users.read', 'users.update', 'users.delete']
          }
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Login failed'
      });
    }
  }

  generateApiToken = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { email, password, pluginName } = request.body as any;

      // Simple validation
      if (!email || !password) {
        reply.status(400).send({
          error: 'Missing credentials',
          message: 'Email and password are required'
        });
        return;
      }

      // Generate a proper API token for QGIS Plugin
      const apiToken = `vungu-api-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      
      // Store token info (in production, save to database)
      const tokenInfo = {
        token: apiToken,
        pluginName: pluginName || 'vungu-qgis-plugin',
        email: email,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
        permissions: ['api.read', 'api.write', 'layers.sync', 'styles.manage']
      };

      reply.send({
        success: true,
        data: {
          apiToken: apiToken,
          tokenInfo: tokenInfo,
          message: 'API token generated successfully for QGIS Plugin'
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to generate API token'
      });
    }
  }

  emailApiToken = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { token, email, pluginName } = request.body as any;

      // Validate input
      if (!token || !email) {
        reply.status(400).send({
          error: 'Missing required fields',
          message: 'Token and email are required'
        });
        return;
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        reply.status(400).send({
          error: 'Invalid email format',
          message: 'Please provide a valid email address'
        });
        return;
      }

      // Create email content
      const emailContent = {
        to: email,
        subject: `🔐 Vungu API Token for ${pluginName || 'QGIS Plugin'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="margin: 0; font-size: 24px;">🔐 Vungu API Token</h1>
              <p style="margin: 10px 0 0 0; opacity: 0.9;">Your API token for QGIS Plugin integration</p>
            </div>
            
            <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e9ecef;">
              <h2 style="color: #2c3e50; margin-top: 0;">Your API Token</h2>
              <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #3498db; margin: 20px 0;">
                <code style="font-size: 16px; color: #2c3e50; word-break: break-all; display: block;">${token}</code>
              </div>
              
              <h3 style="color: #2c3e50;">How to Use:</h3>
              <ol style="color: #495057; line-height: 1.6;">
                <li>Open QGIS</li>
                <li>Go to Plugins → Vungu Integration</li>
                <li>Enter API URL: <code style="background: #f8f9fa; padding: 2px 6px; border-radius: 4px;">http://localhost:3001/api</code></li>
                <li>Enter API Token: <code style="background: #f8f9fa; padding: 2px 6px; border-radius: 4px;">${token}</code></li>
                <li>Click "Test Connection"</li>
              </ol>
              
              <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; color: #1976d2;"><strong>🔒 Security Note:</strong> Keep this token secure and never share it publicly.</p>
              </div>
              
              <div style="text-align: center; margin-top: 30px;">
                <p style="color: #6c757d; font-size: 14px; margin: 0;">
                  Generated on ${new Date().toLocaleString()}<br>
                  Vungu Spatial Data Portal
                </p>
              </div>
            </div>
          </div>
        `,
        text: `
Vungu API Token for QGIS Plugin

Your API Token: ${token}

How to Use:
1. Open QGIS
2. Go to Plugins → Vungu Integration
3. Enter API URL: http://localhost:3001/api
4. Enter API Token: ${token}
5. Click "Test Connection"

Security Note: Keep this token secure and never share it publicly.

Generated on ${new Date().toLocaleString()}
Vungu Spatial Data Portal
        `
      };

      // For development, we'll simulate email sending and log the content
      // In production, you would integrate with a real email service like:
      // - Nodemailer with SMTP
      // - SendGrid
      // - AWS SES
      // - Mailgun
      
      console.log('📧 Email Content:', JSON.stringify(emailContent, null, 2));
      
      // Simulate email sending delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // For now, return success with the email content for development
      reply.send({
        success: true,
        data: {
          message: 'API token email sent successfully',
          email: email,
          tokenPreview: token.substring(0, 8) + '...' + token.substring(token.length - 4),
          sentAt: new Date().toISOString(),
          // In development, return the email content for testing
          emailContent: emailContent
        }
      });
    } catch (error) {
      console.error('Email sending error:', error);
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to send email with API token'
      });
    }
  }

  refreshToken = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { refreshToken } = request.body as any;

      if (!refreshToken) {
        reply.status(400).send({
          error: 'Missing refresh token',
          message: 'Refresh token is required'
        });
        return;
      }

      // TODO: Implement actual token refresh logic
      reply.send({
        data: {
          token: 'new-mock-jwt-token',
          refreshToken: 'new-mock-refresh-token'
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Token refresh failed'
      });
    }
  }

  logout = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { refreshToken } = request.body as any;

      // TODO: Implement actual logout logic
      reply.send({
        message: 'Logged out successfully'
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Logout failed'
      });
    }
  }

  getProfile = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      // TODO: Implement actual profile retrieval logic
      reply.send({
        data: {
          id: 1,
          email: 'admin@example.com',
          role: 'super_admin',
          permissions: ['users.create', 'users.read', 'users.update', 'users.delete'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Profile retrieval failed'
      });
    }
  }

  updateProfile = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const updates = request.body as any;

      // TODO: Implement actual profile update logic
      reply.send({
        data: {
          id: 1,
          email: updates.email || 'admin@example.com',
          role: updates.role || 'super_admin',
          permissions: updates.permissions || ['users.create', 'users.read', 'users.update', 'users.delete'],
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Profile update failed'
      });
    }
  }

  checkAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      // TODO: Implement actual auth check logic
      reply.send({
        authenticated: true,
        user: {
          id: 1,
          email: 'admin@example.com',
          role: 'super_admin'
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Auth check failed'
      });
    }
  }
}
