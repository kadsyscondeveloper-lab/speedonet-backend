const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');

// Install: npm install inquirer

async function pickAndEncode() {
  try {
    // Get all image files from current directory
    const files = fs.readdirSync('./').filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
    });

    if (files.length === 0) {
      console.log('❌ No images found in current directory');
      console.log('Place your images (.jpg, .png, .webp) in this folder first');
      process.exit(1);
    }

    // Image picker prompt
    const { selectedImage } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedImage',
        message: 'Select image to upload:',
        choices: files,
      },
    ]);

    // Metadata prompts
    const { title, subtitle, description, order } = await inquirer.prompt([
      {
        type: 'input',
        name: 'title',
        message: 'Title (optional):',
        default: 'Speedo Prime',
      },
      {
        type: 'input',
        name: 'subtitle',
        message: 'Subtitle (optional):',
        default: 'Watch your favorite content',
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description (optional):',
        default: '',
      },
      {
        type: 'number',
        name: 'order',
        message: 'Display order:',
        default: 1,
      },
    ]);

    // Read and encode image
    const imagePath = path.join('./', selectedImage);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64String = imageBuffer.toString('base64');

    // Determine MIME type
    const ext = path.extname(selectedImage).toLowerCase();
    const mimeTypeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    const mimeType = mimeTypeMap[ext];

    // Create payload
    const payload = {
      title: title || null,
      subtitle: subtitle || null,
      image_data: base64String,
      image_mime: mimeType,
      description: description || null,
      order,
    };

    // Save to file
    const outputFile = 'carousel-payload.json';
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));

    console.log('\n✅ Payload created successfully!\n');
    console.log(`📁 Image: ${selectedImage}`);
    console.log(`📊 Size: ${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    console.log(`🔤 MIME: ${mimeType}`);
    console.log(`💾 Saved to: ${outputFile}\n`);

    // Show upload command
    console.log('📤 Upload command:');
    console.log(`curl -X POST http://localhost:3000/api/v1/carousels \\`);
    console.log(`  -H "Content-Type: application/json" \\`);
    console.log(`  -d @${outputFile}\n`);

    // Option to test API
    const { testNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'testNow',
        message: 'Upload to API now?',
        default: false,
      },
    ]);

    if (testNow) {
      console.log('\n⏳ Uploading...\n');
      const response = await fetch('http://localhost:3000/api/v1/carousels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok) {
        console.log('✅ Upload successful!');
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log('❌ Upload failed!');
        console.log(JSON.stringify(data, null, 2));
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

pickAndEncode();