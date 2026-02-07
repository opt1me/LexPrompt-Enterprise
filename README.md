<div align="center">
  <h1 align="center">LexPrompt Enterprise</h1>
  <p align="center">
    <strong>Next-Generation AI Legal Contract Analysis Platform</strong>
  </p>

  <p align="center">
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19.0-blue?logo=react&logoColor=white" alt="React"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript&logoColor=white" alt="TypeScript"></a>
    <a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/Vite-6.0-purple?logo=vite&logoColor=white" alt="Vite"></a>
    <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS-3.4-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind CSS"></a>
    <br/>
    <a href="https://deepmind.google/technologies/gemini/"><img src="https://img.shields.io/badge/AI-Gemini_3.0-4285F4?logo=google&logoColor=white" alt="Gemini"></a>
    <a href="https://openai.com/"><img src="https://img.shields.io/badge/AI-GPT_5-412991?logo=openai&logoColor=white" alt="OpenAI"></a>
    <a href="https://www.anthropic.com/"><img src="https://img.shields.io/badge/AI-Claude_3.5-d97757?logo=anthropic&logoColor=white" alt="Claude"></a>
  </p>
</div>

---

## 🚀 Overview

**LexPrompt Enterprise** is a high-performance, AI-driven legal tech platform designed to accelerate contract review and risk assessment. It leverages state-of-the-art Large Language Models (LLMs) to automatically extract key clauses, identify risks based on custom playbooks, and provide actionable insights with verbatim evidence.

Whether you are reviewing a single NDA or batch-processing hundreds of vendor agreements, LexPrompt provides a unified, secure, and intelligent workspace.

## ✨ Key Features

### 🧠 Multi-Model Intelligence

Seamlessly switch between top-tier AI providers depending on your task's complexity and budget:

- **Google Gemini 3.0 Pro**: High speed and long context window.
- **OpenAI GPT-5**: Advanced reasoning and strict JSON schema adherence.
- **Anthropic Claude 3.5 Sonnet**: Superior nuance in legal drafting.

### 📊 Matrix Tabular Review

Transform unstructured documents into structured data.

- **Parallel Processing**: Extract data from multiple documents simultaneously.
- **Batch-Style Cards**: Click any cell to see a detailed analysis card with **Risk Analysis**, **Summaries**, and **Verbatim Citations**.
- **Auto-Resize Inputs**: Smooth, responsive editing experience for refining AI outputs.

### ⚡ Batch Analysis Engine

Process entire folders of contracts in minutes.

- **Visual Progress**: Real-time tracking of analysis status.
- **Consolidated Reporting**: Export findings to CSV or formatted Word documents.
- **Risk Heatmaps**: Instantly spot high-risk documents with color-coded badges.

### 🛡️ Configurable Risk Engine

Define your own legal playbooks.

- **Custom Templates**: Create extraction templates with specific risk criteria (e.g., "Must be mutual", "Cap > 2x fees").
- **Automated Scoring**: The AI evaluates clauses against your specific rules, flagging High/Medium/Low risks automatically.
- **Smart Citations**: Uses fuzzy matching algorithms to link AI findings to the exact text in the document.

### 💬 Interactive Assistant

- **Chat with Context**: Ask questions about your specific contracts (e.g., "What is the indemnity cap in the Acme Agreement?").
- **Drafting Aide**: Generate email summaries or rewrite clauses to mitigate risk directly within the app.

## 🛠️ Technology Stack

- **Frontend**: React 19, TypeScript, Vite
- **Styling**: Tailwind CSS, Lucide React Icons
- **AI Integration**: Official SDKs for Google GenAI, OpenAI, and Anthropic
- **Document Handling**: Custom PDF viewer with citation highlighting

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- API Keys for at least one provider (Gemini, OpenAI, or Anthropic)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/opt1me/LexPrompt-Enterprise.git
   cd LexPrompt-Enterprise
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure Environment**
   Create a `.env.local` file in the root directory (optional, keys can be set in UI):

   ```env
   VITE_GEMINI_API_KEY=your_key_here
   VITE_OPENAI_API_KEY=your_key_here
   ```

4. **Run the Development Server**

   ```bash
   npm run dev
   ```

5. **Build for Production**

   ```bash
   npm run build
   ```

## 🔒 Security Note

This application processes sensitive legal documents. API keys are stored securely in your browser's `localStorage` and are never sent to our servers. Document processing happens directly between your browser and the chosen AI provider's API.

---

<p align="center">Built with ❤️ by the LexPrompt Team</p>
