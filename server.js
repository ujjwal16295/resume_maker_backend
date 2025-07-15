const express = require('express');
const multer = require('multer');
require('dotenv').config();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// Configure CORS with specific options
app.use(cors({
  origin: "https://resume-maker-frontend-eight.vercel.app/" || ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads - PDF ONLY
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Only allow PDF files
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Helper function to parse AI response and extract HTML
function parseAIResponse(aiResponse) {
  try {
    console.log('Parsing AI response...');
    
    // Clean the response to extract JSON
    let cleanResponse = aiResponse.replace(/```json\s*|\s*```/g, '').trim();
    
    // Remove any markdown formatting that might be around the JSON
    if (cleanResponse.startsWith('```') && cleanResponse.endsWith('```')) {
      cleanResponse = cleanResponse.slice(3, -3).trim();
    }
    
    // Try to parse as JSON first
    try {
      const jsonResponse = JSON.parse(cleanResponse);
      if (jsonResponse.htmlres) {
        console.log('Successfully parsed JSON response');
        return jsonResponse.htmlres;
      }
    } catch (jsonError) {
      console.log('JSON parsing failed, trying manual extraction');
    }
    
    // Enhanced fallback: try to extract HTML from response manually
    const htmlMatch = aiResponse.match(/"htmlres"\s*:\s*"([\s\S]*?)"\s*}/);
    if (htmlMatch) {
      console.log('Successfully extracted HTML using regex');
      return htmlMatch[1];
    }
    
    // Last resort: look for HTML content directly
    const directHtmlMatch = aiResponse.match(/<html[\s\S]*?<\/html>/i);
    if (directHtmlMatch) {
      console.log('Successfully extracted HTML directly');
      return directHtmlMatch[0];
    }
    
    throw new Error('Could not extract HTML content from AI response');
    
  } catch (error) {
    console.error('Error parsing AI response:', error);
    throw error;
  }
}

// Function to properly decode escaped HTML content
function decodeHTMLContent(htmlContent) {
  if (!htmlContent) return '';
  
  return htmlContent
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\'/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

// Helper function to convert HTML to PDF using Puppeteer
async function convertHTMLtoPDF(htmlContent) {
    let browser;
    try {
      console.log('Converting HTML to PDF using Puppeteer...');
      
      // Ensure we have clean HTML
      if (!htmlContent || htmlContent.trim().length === 0) {
        throw new Error('HTML content is empty');
      }
      
      // Clean and prepare HTML content - USE AI'S HTML DIRECTLY
      let cleanHTML = htmlContent.trim();
      
      // Remove any potential markdown artifacts
      cleanHTML = cleanHTML.replace(/```html\s*|\s*```/g, '').trim();
      
      // REMOVED: The hardcoded HTML wrapper - use AI's HTML directly
      
      console.log('Using AI-generated HTML directly for PDF conversion');
      
      // Launch Puppeteer browser
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      });
      
      const page = await browser.newPage();
      
      // Set page content with AI's HTML
      await page.setContent(cleanHTML, { 
        waitUntil: 'networkidle0',
        timeout: 30000 
      });
      
      // Generate PDF with single page optimization
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '0.5in',
          right: '0.5in',
          bottom: '0.5in',
          left: '0.5in'
        },
        preferCSSPageSize: true,
        // Add page range to ensure single page
        pageRanges: '1'
      });
      
      console.log('HTML to PDF conversion successful, buffer size:', pdfBuffer.length);
      return pdfBuffer;
      
    } catch (error) {
      console.error('Error converting HTML to PDF:', error);
      throw new Error('Failed to convert HTML to PDF: ' + error.message);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  
  // Helper function to call Gemini AI with PDF
  async function getGeminiSuggestionsWithPDF(filePath, jobRequirements) {
    try {
      console.log('Calling Gemini AI with PDF...');
      
      const prompt = `
  You are an expert resume optimizer and designer. I will provide you with a resume PDF and job requirements. 
  Your task is to analyze the resume and create a completely optimized, professional, and visually appealing ONE-PAGE resume in HTML format.
  
  CRITICAL REQUIREMENTS:
  1. Create a COMPLETE HTML document with DOCTYPE, html, head, and body tags
  2. ALL CSS must be inline or in a <style> tag within the <head>
  3. The resume MUST fit on EXACTLY ONE PAGE when converted to PDF (A4 format)
  4. Use concise, impactful content to fit everything on one page
  5. Optimize content for ATS (Applicant Tracking System)
  6. Include relevant keywords from the job requirements
  7. Use professional design with good spacing and typography
  8. Focus on achievements and quantifiable results
  9. Prioritize most relevant information for the job
  
  DESIGN SPECIFICATIONS:
  - Use A4 page dimensions (210mm x 297mm)
  - Set appropriate margins (0.5in recommended)
  - Use font sizes that ensure readability but maximize space efficiency
  - Professional color scheme (blues, grays, or conservative colors)
  - Clear section hierarchy with proper headings
  - Efficient use of white space
  - Modern, clean layout that's easy to scan
  
  CONTENT OPTIMIZATION:
  - Prioritize information most relevant to the job requirements
  - Use bullet points for achievements, not duties
  - Quantify results where possible (percentages, numbers, etc.)
  - Keep descriptions concise and impactful
  - Include relevant technical skills and keywords
  - Remove or minimize less relevant information to fit one page
  
  ONE-PAGE CONSTRAINT:
  - This is NON-NEGOTIABLE - the entire resume must fit on one page
  - Adjust content length, font sizes, and spacing as needed
  - Prioritize quality over quantity of information
  - Use efficient layouts (two columns if needed)
  
  JOB REQUIREMENTS:
  ${jobRequirements}
  
  IMPORTANT: Your response must be in this exact JSON format:
  {
    "htmlres": "YOUR_COMPLETE_HTML_RESUME_HERE"
  }
  
  The HTML should be a complete, self-contained document that will render perfectly as a single-page PDF. Include all necessary CSS styling within the HTML document.
  `;
  
      // Read the PDF file
      const pdfData = fs.readFileSync(filePath);
      
      // Get the model
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      
      // Prepare the request
      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: pdfData.toString('base64')
                }
              }
            ]
          }
        ]
      };
      
      // Generate content
      const result = await model.generateContent(request);
      const response = await result.response;
      const text = response.text();
  
      console.log('AI response received, length:', text.length);
      return text;
      
    } catch (error) {
      console.error('Error calling Gemini AI:', error);
      throw new Error('Failed to get AI suggestions: ' + error.message);
    }
  }

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Resume Optimizer API',
    status: 'Running',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      optimize: '/api/optimize-resume',
      test: '/api/test-html-to-pdf'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Resume optimizer API is running',
    timestamp: new Date().toISOString()
  });
});

// Main endpoint for resume optimization
app.post('/api/optimize-resume', upload.single('resume'), async (req, res) => {
  try {
    const { jobRequirements } = req.body;
    
    console.log('Received resume optimization request');
    
    if (!req.file) {
      return res.status(400).json({ error: 'PDF resume file is required' });
    }
    
    if (!jobRequirements) {
      return res.status(400).json({ error: 'Job requirements are required' });
    }
    
    console.log('Processing PDF resume optimization...');
    console.log('File path:', req.file.path);
    console.log('Job requirements length:', jobRequirements.length);
    
    // Get AI suggestions by sending PDF directly to Gemini
    const suggestions = await getGeminiSuggestionsWithPDF(
      req.file.path, 
      jobRequirements
    );
    
    console.log('AI suggestions received');
    
    // Parse and extract HTML content from AI response
    let htmlContent = parseAIResponse(suggestions);
    
    // Decode escaped characters
    htmlContent = decodeHTMLContent(htmlContent);
    
    console.log('HTML content extracted and decoded successfully, length:', htmlContent.length);
    
    // Convert HTML to PDF using Puppeteer
    const pdfBuffer = await convertHTMLtoPDF(htmlContent);
    
    // Clean up uploaded file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log('Uploaded file cleaned up');
    }
    
    console.log('Sending PDF response, buffer size:', pdfBuffer.length);
    
    // Send the PDF file back with proper headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="optimized-resume.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Error processing PDF resume:', error);
    
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log('Uploaded file cleaned up after error');
    }
    
    res.status(500).json({ 
      error: 'Failed to process PDF resume', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Test endpoint for HTML to PDF conversion
app.post('/api/test-html-to-pdf', async (req, res) => {
  try {
    const { html } = req.body;
    
    if (!html) {
      return res.status(400).json({ error: 'HTML content is required' });
    }
    
    console.log('Testing HTML to PDF conversion...');
    
    // Convert HTML to PDF
    const pdfBuffer = await convertHTMLtoPDF(html);
    
    // Send the PDF file back
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="test-document.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Error in test conversion:', error);
    res.status(500).json({ 
      error: 'Failed to convert HTML to PDF', 
      message: error.message 
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'PDF file size too large (max 10MB)' });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files uploaded' });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected file field' });
    }
  }
  
  if (error.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: 'Only PDF files are allowed' });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Resume optimizer endpoint: http://localhost:${PORT}/api/optimize-resume`);
  console.log(`Test HTML to PDF endpoint: http://localhost:${PORT}/api/test-html-to-pdf`);
});

module.exports = app;