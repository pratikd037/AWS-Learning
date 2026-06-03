import React, { useState } from 'react';
import { Amplify } from 'aws-amplify';
import { signInWithRedirect, signOut, getCurrentUser, fetchAuthSession } from 'aws-amplify/auth';
import './App.css';

// Configure Amplify using inject config
if (window.config) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: window.config.COGNITO_USER_POOL_ID,
        userPoolClientId: window.config.COGNITO_CLIENT_ID,
        loginWith: {
          oauth: {
            domain: window.config.COGNITO_DOMAIN,
            scopes: ['email', 'openid', 'profile'],
            redirectSignIn: [window.location.origin],
            redirectSignOut: [window.location.origin],
            responseType: 'code'
          }
        }
      }
    }
  });
}

function App() {
  const [user, setUser] = useState(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);

  React.useEffect(() => {
    checkUser();
  }, []);

  const checkUser = async () => {
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
    } catch {
      setUser(null);
    }
  };

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setStatus('');
    setProgress(0);
  };

  const handleUpload = async () => {
    if (!file) {
      setStatus('Please select a file first.');
      return;
    }

    setUploading(true);
    setStatus('Getting upload URL...');
    setProgress(10);

    try {
      // 1. Get pre-signed URL from backend (Authenticated)
      const session = await fetchAuthSession();
      const idToken = session.tokens.idToken;

      const response = await fetch(`/api/upload-url?fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type)}`, {
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });
      
      if (!response.ok) throw new Error('Failed to get upload URL');
      
      const { uploadUrl, key } = await response.json();
      
      setStatus('Uploading to S3...');
      setProgress(40);

      // 2. Upload to S3
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      if (!uploadResponse.ok) throw new Error('S3 upload failed');

      setProgress(100);
      setStatus('Success! File uploaded to S3.');
      setFile(null);
      
      // Reset after success
      setTimeout(() => {
        setStatus('The Lambda function should have been triggered. Check logs!');
      }, 2000);

    } catch (error) {
      console.error('Upload error:', error);
      setStatus(`Error: ${error.message}`);
      setProgress(0);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="container">
      <div className="glass-card">
        <h1 className="title">Cloud Uploader</h1>
        {user ? (
          <div className="user-info">
            <span>Welcome, {user.username || 'User'}</span>
            <button onClick={() => signOut()} className="auth-button secondary">Sign Out</button>
          </div>
        ) : (
          <div className="login-section">
            <button onClick={() => signInWithRedirect({ provider: 'Google' })} className="auth-button primary">Sign in with Google</button>
          </div>
        )}
        <p className="subtitle">Securely bridge your data to AWS S3 + Lambda</p>
        
        {user && (
          <div className="upload-section">
            <label className="file-input-label">
              <input type="file" onChange={handleFileChange} />
              <span>{file ? file.name : 'Choose a file...'}</span>
            </label>
            
            <button 
              onClick={handleUpload} 
              disabled={uploading || !file}
              className={`upload-button ${uploading ? 'loading' : ''}`}
            >
              {uploading ? 'Uploading...' : 'Upload to Cloud'}
            </button>
          </div>
        )}

        {status && (
          <div className={`status-message ${status.includes('Error') ? 'error' : 'success'}`}>
            {status}
          </div>
        )}

        {uploading && (
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progress}%` }}></div>
          </div>
        )}

        <div className="info-section">
          <h3>WorkFlow:</h3>
          <ul>
            <li>React Frontend requests signed URL</li>
            <li>Node.js Backend (EC2) authorizes</li>
            <li>Direct Upload to S3</li>
            <li>Lambda triggers automatically</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default App;
