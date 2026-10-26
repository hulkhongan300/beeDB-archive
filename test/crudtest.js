import axios from 'axios';

const baseURL = 'http://localhost:4000';

async function testCRUD() {
  const key = 'dog';
  try {
    // Create
    let res = await axios.post(`${baseURL}/db/c?key=${key}`, { value: { name: 'Bob', age: 25 } });
    console.log('Create:', res.data);

    // Read
    res = await axios.get(`${baseURL}/db/r?key=${key}`);
    console.log('Read:', res.data);

    // Update
    res = await axios.post(`${baseURL}/db/u?key=${key}`, { value: { age: 26 } });
    console.log('Update:', res.data);

    // Delete
    res = await axios.delete(`${baseURL}/db/d?key=${key}`);
    console.log('Delete:', res.data);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

testCRUD();